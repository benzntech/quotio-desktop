//! 智能账号调度：按规则选出唯一目标账号，其余打 standby 标记临时禁用，
//! 让 CLIProxyAPI（只用未禁用账号）实际只能用目标账号。
//!
//! 规则「reset_soonest」（临近刷新优先）：5h 窗口最早刷新的账号优先——
//! 窗口余量是会过期的资源，先用快刷新的不浪费；闲置账号（无活跃窗口，
//! 一用就开全新 5h 窗口）留作储备排最后。打满、鉴权失败、用户手动禁用、
//! Codex 一键启动绑定的账号不参与调度。
//!
//! 设计要点（docs/account-scheduler-plan.md）：
//! - 调度器只动自己标记过的账号（`quotio_scheduler_standby`），
//!   用户手动禁用（`disabled` 无标记）永远不碰；
//! - fail-open：无可用账号 / 规则关闭 / 退出软件 → 恢复所有 standby 回池。

use std::path::Path;
use std::time::Duration;

use quotio_types::AccountQuota;
use serde_json::Value;

use crate::codex_launch;

/// 调度器临时禁用（待命）标记，写在账号 auth JSON 里，可还原。
pub(crate) const STANDBY_FIELD: &str = "quotio_scheduler_standby";
/// Codex 一键启动绑定标记（codex_launch 写入），带它的账号调度器不碰。
const BOUND_FIELD: &str = "quotio_bound_login_only";

/// 池中一个 Codex auth 文件的调度视角。
#[derive(Debug, Clone)]
pub struct PoolFile {
    /// 原始文件名（含 .json），auth 目录内的唯一身份。
    pub file_name: String,
    /// 清洗名（去 "codex-" 前缀和 ".json" 后缀），与 `AccountQuota.account_key` 对应。
    pub key: String,
    pub disabled: bool,
    /// 是否调度器自己标记的临时禁用。
    pub standby: bool,
    /// 是否被 Codex 一键启动绑定占用。
    pub bound: bool,
}

impl PoolFile {
    /// 用户手动禁用（不是调度器禁的）——调度器永远不碰。
    fn user_disabled(&self) -> bool {
        self.disabled && !self.standby
    }
}

/// 一个参与排序的候选账号（池文件 + 配额数据合并后）。
#[derive(Debug, Clone)]
pub struct Candidate {
    pub file_name: String,
    pub key: String,
    pub label: String,
    /// 活跃 5h 窗口的刷新时间（unix 秒）；None = 闲置（无窗口或已过期）。
    pub session_reset_at: Option<i64>,
    /// Weekly 窗口剩余百分比（平手降权用）。
    pub weekly_remaining: f64,
    /// 是否可被选为目标（打满/鉴权失败/用户禁用/绑定占用 → false）。
    pub eligible: bool,
}

/// 与 quota.rs `clean_filename` 同规则，保证和 `AccountQuota.account_key` 对得上。
pub(crate) fn key_for_file(file_name: &str) -> String {
    let trimmed = file_name.strip_prefix("codex-").unwrap_or(file_name);
    trimmed.strip_suffix(".json").unwrap_or(trimmed).to_string()
}

/// 扫描 auth 目录里的 Codex 账号文件（调度只覆盖 Codex）。
pub fn read_pool(dir: &Path) -> Vec<PoolFile> {
    let mut pool = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return pool;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().to_string();
        let Ok(text) = std::fs::read_to_string(&path) else {
            continue;
        };
        let Ok(value) = serde_json::from_str::<Value>(&text) else {
            continue;
        };
        if !codex_launch::is_codex_auth(&file_name, &value) {
            continue;
        }
        let flag = |field: &str| {
            value
                .get(field)
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        };
        pool.push(PoolFile {
            key: key_for_file(&file_name),
            file_name,
            disabled: flag("disabled"),
            standby: flag(STANDBY_FIELD),
            bound: flag(BOUND_FIELD),
        });
    }
    pool.sort_by(|a, b| a.file_name.cmp(&b.file_name));
    pool
}

/// 池文件 + 配额数据 → 候选列表。配额缺失（没拉到）的账号视为不可选，
/// 信息不足时宁可不动它。
pub fn build_candidates(
    pool: &[PoolFile],
    quotas: &[AccountQuota],
    now_unix: i64,
) -> Vec<Candidate> {
    pool.iter()
        .map(|file| {
            let quota = quotas
                .iter()
                .find(|q| q.provider_id == "codex" && q.account_key == file.key);
            let session_reset_at = quota
                .and_then(|q| q.models.iter().find(|m| m.model == "Session"))
                .and_then(|m| m.reset_at_unix)
                // 已过期的窗口等于没有窗口（闲置）。
                .filter(|reset| *reset > now_unix);
            let weekly_remaining = quota
                .and_then(|q| q.models.iter().find(|m| m.model == "Weekly"))
                .map(|m| m.remaining_percent)
                .unwrap_or(100.0);
            let auth_failed = quota
                .map(|q| q.status_message.as_deref() == Some("auth_failed"))
                .unwrap_or(false);
            let eligible = !file.bound
                && !file.user_disabled()
                && quota.map(|q| !q.is_forbidden).unwrap_or(false)
                && !auth_failed;
            Candidate {
                file_name: file.file_name.clone(),
                key: file.key.clone(),
                label: quota
                    .map(|q| q.account_label.clone())
                    .unwrap_or_else(|| file.key.clone()),
                session_reset_at,
                weekly_remaining,
                eligible,
            }
        })
        .collect()
}

/// 排序键：活跃窗口在前（按刷新时间升序），闲置垫后；平手看 Weekly 剩余多者优先。
fn rank(candidate: &Candidate) -> (u8, i64, i64, String) {
    match candidate.session_reset_at {
        Some(reset) => (
            0,
            reset,
            -(candidate.weekly_remaining.round() as i64),
            candidate.key.clone(),
        ),
        None => (
            1,
            i64::MAX,
            -(candidate.weekly_remaining.round() as i64),
            candidate.key.clone(),
        ),
    }
}

/// 纯函数规则引擎：从候选里选目标（返回文件名）。
///
/// 滞回：当前账号仍可用时，未满最小保持时间不换；主动切换要求候选的
/// 刷新时间比当前早 `switch_margin_secs` 以上（当前闲置而候选有活跃窗口除外）。
/// 当前账号打满/出错（不再 eligible）→ 立即切最优。无可用账号 → None。
pub fn pick_target(
    candidates: &[Candidate],
    current: Option<(&str, Duration)>,
    min_hold: Duration,
    switch_margin_secs: i64,
) -> Option<String> {
    let eligible: Vec<&Candidate> = candidates.iter().filter(|c| c.eligible).collect();
    let best = eligible.iter().min_by_key(|c| rank(c))?;

    if let Some((current_file, held)) = current {
        if let Some(current) = eligible.iter().find(|c| c.file_name == current_file) {
            if best.file_name == current.file_name {
                return Some(current.file_name.clone());
            }
            if held < min_hold {
                return Some(current.file_name.clone());
            }
            return match (best.session_reset_at, current.session_reset_at) {
                // 候选要明显更早刷新才值得切。
                (Some(best_reset), Some(current_reset))
                    if best_reset + switch_margin_secs <= current_reset =>
                {
                    Some(best.file_name.clone())
                }
                // 当前已是闲置（窗口过期/未开）而候选有活跃窗口：切。
                (Some(_), None) => Some(best.file_name.clone()),
                _ => Some(current.file_name.clone()),
            };
        }
    }
    Some(best.file_name.clone())
}

/// 守门执行：让池子里只有 `target_file` 可用。
/// 其余启用中的账号打 standby 禁用；目标若被 standby 禁着则还原。
/// 绑定占用和用户手动禁用的账号不碰。返回 (是否有改动, 当前待命数)。
pub fn apply_target_in(
    dir: &Path,
    pool: &[PoolFile],
    target_file: &str,
) -> (bool, u32) {
    let mut changed = false;
    let mut standby_count = 0_u32;
    for file in pool {
        if file.bound || file.user_disabled() {
            continue;
        }
        let path = dir.join(&file.file_name);
        if file.file_name == target_file {
            if file.standby {
                changed |= set_standby(&path, false).is_ok();
            }
        } else if !file.disabled {
            if set_standby(&path, true).is_ok() {
                changed = true;
                standby_count += 1;
            }
        } else if file.standby {
            standby_count += 1;
        }
    }
    (changed, standby_count)
}

/// fail-open / 关闭调度 / 退出软件：恢复所有 standby 账号回池。返回是否有改动。
pub fn release_all_in(dir: &Path) -> bool {
    let mut changed = false;
    for file in read_pool(dir) {
        if file.standby {
            changed |= set_standby(&dir.join(&file.file_name), false).is_ok();
        }
    }
    changed
}

/// 写 standby 状态：true → `disabled=true` + 标记；false → `disabled=false` + 去标记。
/// 只在调度器确认该文件可动（非 bound、非用户禁用）后调用。
fn set_standby(path: &Path, standby: bool) -> Result<(), String> {
    let mut value = codex_launch::read_proxy_account_from(path)?;
    let object = value
        .as_object_mut()
        .ok_or_else(|| format!("账号文件不是 JSON 对象: {}", path.display()))?;
    if standby {
        object.insert("disabled".to_string(), Value::Bool(true));
        object.insert(STANDBY_FIELD.to_string(), Value::Bool(true));
    } else {
        object.insert("disabled".to_string(), Value::Bool(false));
        object.remove(STANDBY_FIELD);
    }
    codex_launch::write_proxy_account_to(path, &value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use quotio_types::QuotaModelUsage;

    fn candidate(
        key: &str,
        session_reset_at: Option<i64>,
        weekly_remaining: f64,
        eligible: bool,
    ) -> Candidate {
        Candidate {
            file_name: format!("codex-{key}.json"),
            key: key.to_string(),
            label: format!("{key}@example.com"),
            session_reset_at,
            weekly_remaining,
            eligible,
        }
    }

    const HOLD: Duration = Duration::from_secs(600);
    const MARGIN: i64 = 900;

    #[test]
    fn key_matches_quota_clean_filename_rule() {
        assert_eq!(key_for_file("codex-abc.json"), "abc");
        assert_eq!(key_for_file("abc.json"), "abc");
        assert_eq!(key_for_file("codex-a-b.json"), "a-b");
    }

    #[test]
    fn picks_soonest_reset_and_parks_idle_accounts_last() {
        let candidates = vec![
            candidate("idle", None, 100.0, true),
            candidate("late", Some(10_000), 50.0, true),
            candidate("soon", Some(2_000), 10.0, true),
        ];
        let target = pick_target(&candidates, None, HOLD, MARGIN);
        assert_eq!(target.as_deref(), Some("codex-soon.json"));
    }

    #[test]
    fn skips_ineligible_and_falls_back_to_idle_reserve() {
        let candidates = vec![
            candidate("forbidden", Some(1_000), 80.0, false),
            candidate("idle-a", None, 30.0, true),
            candidate("idle-b", None, 90.0, true),
        ];
        // 闲置储备里选 Weekly 剩余多的。
        let target = pick_target(&candidates, None, HOLD, MARGIN);
        assert_eq!(target.as_deref(), Some("codex-idle-b.json"));
    }

    #[test]
    fn returns_none_when_no_account_is_eligible() {
        let candidates = vec![candidate("a", Some(1_000), 0.0, false)];
        assert_eq!(pick_target(&candidates, None, HOLD, MARGIN), None);
    }

    #[test]
    fn keeps_current_within_min_hold() {
        let candidates = vec![
            candidate("cur", Some(9_000), 50.0, true),
            candidate("soon", Some(1_000), 50.0, true),
        ];
        let target = pick_target(
            &candidates,
            Some(("codex-cur.json", Duration::from_secs(60))),
            HOLD,
            MARGIN,
        );
        assert_eq!(target.as_deref(), Some("codex-cur.json"));
    }

    #[test]
    fn switches_only_when_candidate_is_better_by_margin() {
        let candidates = vec![
            candidate("cur", Some(3_000), 50.0, true),
            candidate("soon", Some(2_500), 50.0, true),
        ];
        // 仅早 500s < 900s 门槛：不切。
        let held = Some(("codex-cur.json", Duration::from_secs(3_600)));
        assert_eq!(
            pick_target(&candidates, held, HOLD, MARGIN).as_deref(),
            Some("codex-cur.json")
        );
        // 早 1200s ≥ 门槛：切。
        let candidates = vec![
            candidate("cur", Some(3_000), 50.0, true),
            candidate("soon", Some(1_800), 50.0, true),
        ];
        assert_eq!(
            pick_target(&candidates, held, HOLD, MARGIN).as_deref(),
            Some("codex-soon.json")
        );
    }

    #[test]
    fn switches_immediately_when_current_becomes_ineligible() {
        let candidates = vec![
            candidate("cur", Some(1_000), 50.0, false), // 打满
            candidate("next", Some(5_000), 50.0, true),
        ];
        let target = pick_target(
            &candidates,
            Some(("codex-cur.json", Duration::from_secs(10))),
            HOLD,
            MARGIN,
        );
        assert_eq!(target.as_deref(), Some("codex-next.json"));
    }

    #[test]
    fn switches_off_idle_current_when_active_window_appears() {
        // 当前账号窗口已过期（闲置），候选有活跃窗口：过保持期后立即切。
        let candidates = vec![
            candidate("cur", None, 50.0, true),
            candidate("active", Some(9_999), 50.0, true),
        ];
        let target = pick_target(
            &candidates,
            Some(("codex-cur.json", Duration::from_secs(3_600))),
            HOLD,
            MARGIN,
        );
        assert_eq!(target.as_deref(), Some("codex-active.json"));
    }

    #[test]
    fn build_candidates_joins_quota_and_normalizes_expired_window() {
        let pool = vec![
            PoolFile {
                file_name: "codex-a.json".into(),
                key: "a".into(),
                disabled: false,
                standby: false,
                bound: false,
            },
            PoolFile {
                file_name: "codex-b.json".into(),
                key: "b".into(),
                disabled: true, // 用户手动禁用
                standby: false,
                bound: false,
            },
        ];
        let quota = |key: &str, reset: Option<i64>, forbidden: bool| AccountQuota {
            provider_id: "codex".into(),
            account_label: format!("{key}@x.com"),
            account_key: key.into(),
            is_forbidden: forbidden,
            status_message: None,
            models: vec![QuotaModelUsage {
                model: "Session".into(),
                used_percent: 10.0,
                remaining_percent: 90.0,
                reset_at: None,
                reset_at_unix: reset,
            }],
        };
        let now = 5_000;
        let quotas = vec![quota("a", Some(3_000), false), quota("b", Some(9_000), false)];
        let candidates = build_candidates(&pool, &quotas, now);

        // a 的窗口 3000 < now=5000 → 过期视为闲置。
        assert_eq!(candidates[0].session_reset_at, None);
        assert!(candidates[0].eligible);
        // b 用户手动禁用 → 不可选。
        assert!(!candidates[1].eligible);
    }

    #[test]
    fn apply_and_release_roundtrip_respects_user_disabled_and_bound() {
        let dir = std::env::temp_dir().join(format!(
            "ql_scheduler_apply_{}_{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let write = |name: &str, body: &str| std::fs::write(dir.join(name), body).unwrap();
        let base = r#""type":"codex","access_token":"a","id_token":"i","refresh_token":"r""#;
        write("codex-target.json", &format!("{{{base}}}"));
        write("codex-other.json", &format!("{{{base}}}"));
        write(
            "codex-user-off.json",
            &format!("{{{base},\"disabled\":true}}"),
        );
        write(
            "codex-bound.json",
            &format!("{{{base},\"disabled\":true,\"quotio_bound_login_only\":true}}"),
        );

        let pool = read_pool(&dir);
        assert_eq!(pool.len(), 4);
        let (changed, standby_count) = apply_target_in(&dir, &pool, "codex-target.json");
        assert!(changed);
        assert_eq!(standby_count, 1);

        let pool = read_pool(&dir);
        let by_name = |name: &str| pool.iter().find(|f| f.file_name == name).unwrap();
        assert!(!by_name("codex-target.json").disabled);
        assert!(by_name("codex-other.json").disabled);
        assert!(by_name("codex-other.json").standby);
        // 用户手动禁用、绑定占用：原样不动。
        assert!(by_name("codex-user-off.json").disabled);
        assert!(!by_name("codex-user-off.json").standby);
        assert!(by_name("codex-bound.json").disabled);
        assert!(!by_name("codex-bound.json").standby);

        assert!(release_all_in(&dir));
        let pool = read_pool(&dir);
        let by_name = |name: &str| pool.iter().find(|f| f.file_name == name).unwrap();
        assert!(!by_name("codex-other.json").disabled);
        assert!(!by_name("codex-other.json").standby);
        assert!(by_name("codex-user-off.json").disabled);
        assert!(by_name("codex-bound.json").disabled);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
