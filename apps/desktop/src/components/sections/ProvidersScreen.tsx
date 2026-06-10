import { useState, useEffect, useRef, useMemo, memo, type ChangeEvent } from "react";
import type { AccountAuthHealth, AppState, AuthFile, OAuthStatusResponse, OAuthUrlResponse, ProviderSummary } from "../../types";
import { maskEmail, matchAuthFile } from "../../lib/format";
import { PlusIcon, RefreshIcon, TrashIcon } from "../icons";
import { useT } from "../../i18n";
import { invoke } from "../../lib/tauri";
import { Select } from "../Select";

type CustomProvider = { id: string; name: string; base_url: string; api_key: string; kind: string; prefix?: string };

type ProvidersScreenProps = {
  appState: AppState;
  isManagementBusy: boolean;
  managementAction: string | null;
  onRefreshManagement: () => void;
  onRefreshQuotas: () => void;
  onRunManagementStateAction: (command: string, args?: Record<string, unknown>) => void;
  onStartOAuth: (endpoint: string, projectId: string | null, isWebui?: boolean) => Promise<OAuthUrlResponse | null>;
  onPollOAuth: (token: string) => Promise<OAuthStatusResponse | null>;
};

type OAuthSession = {
  providerName: string;
  url: string | null;
  state: string | null;
  status: string;
  error: string | null;
};

type AccountGroupData = {
  id: string;
  label: string;
  colorHex: string;
  accounts: AuthFile[];
};

export function ProvidersScreen({
  appState,
  isManagementBusy,
  managementAction,
  onRefreshManagement,
  onRefreshQuotas,
  onRunManagementStateAction,
  onStartOAuth,
  onPollOAuth,
}: ProvidersScreenProps) {
  const t = useT();
  const proxyAuthFiles = appState.management.auth_files ?? [];
  // Fall back to the local auth dir so existing accounts show even when the
  // proxy (and its /auth-files) isn't connected.
  const [localAccounts, setLocalAccounts] = useState<AuthFile[]>([]);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    void invoke<AuthFile[]>("list_local_accounts").then(setLocalAccounts).catch(() => {});
  }, [appState.management.auth_files]);
  const authFiles = proxyAuthFiles.length > 0 ? proxyAuthFiles : localAccounts;
  const groups = useMemo(() => groupAccounts(authFiles, appState.providers), [authFiles, appState.providers]);
  // Accounts whose quota fetch hit an unrecoverable 401 are flagged "auth_failed"
  // by the backend. Unlike the proxy's recent-request health (which resets on
  // restart), this re-detects every refresh, so it's a durable "re-auth" signal.
  const authFailedNames = useMemo(() => {
    const names = new Set<string>();
    for (const quota of appState.quotas) {
      if (quota.status_message === "auth_failed") {
        const file = matchAuthFile(quota, authFiles);
        if (file) names.add(file.name);
      }
    }
    return names;
  }, [appState.quotas, authFiles]);
  // Per-account health from the persisted usage store, classified by REAL HTTP
  // status code (401/403 = auth, 429 = rate-limit, 5xx = transient). Lets the
  // badge tell a genuine auth failure apart from throttling, so "re-authorize"
  // only fires on actual auth problems — not on a blanket recent-failure count.
  const [authHealth, setAuthHealth] = useState<Map<string, AccountAuthHealth>>(new Map());
  useEffect(() => {
    // `invoke` routes to the dev mock in a plain browser, so this also populates
    // during UI iteration; no __TAURI_INTERNALS__ gate needed.
    void invoke<AccountAuthHealth[]>("query_account_auth_health")
      .then((list) => {
        const map = new Map<string, AccountAuthHealth>();
        for (const item of list) map.set(item.account.trim().toLowerCase(), item);
        setAuthHealth(map);
      })
      .catch(() => {});
  }, [appState.management.auth_files, appState.quotas]);
  const oauthProviders = appState.providers.filter((provider) => provider.oauth_endpoint);
  const vertexProvider = appState.providers.find((provider) => provider.id === "vertex");

  const [showAdd, setShowAdd] = useState(false);
  // Two-step confirm for the destructive "clear all accounts" action.
  const [confirmClearAll, setConfirmClearAll] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [oauthSession, setOAuthSession] = useState<OAuthSession | null>(null);
  const [vertexJson, setVertexJson] = useState("");
  const [vertexError, setVertexError] = useState<string | null>(null);
  const [showAddCustom, setShowAddCustom] = useState(false);
  const [editingCustomId, setEditingCustomId] = useState<string | null>(null);
  const [customForm, setCustomForm] = useState({ name: "", base_url: "", api_key: "", kind: "openai", prefix: "" });
  const [customProviders, setCustomProviders] = useState<CustomProvider[]>([]);
  useEffect(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    void invoke<CustomProvider[]>("list_custom_providers").then(setCustomProviders).catch(() => {});
  }, []);

  // Tracks the OAuth `state` currently being auto-polled, so starting a new
  // authorization (or unmounting) cancels the previous polling loop.
  const pollRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      pollRef.current = null;
    },
    [],
  );

  // Open the authorization URL in the system browser (Tauri opener, falling back
  // to window.open), mirroring the macOS reference app's auto-open behavior.
  async function openAuthUrl(url: string) {
    try {
      if ("__TAURI_INTERNALS__" in window) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
        return;
      }
    } catch {
      /* fall back to window.open below */
    }
    window.open(url, "_blank", "noreferrer");
  }

  // Auto-poll the OAuth status (mirrors the macOS reference app's pollOAuthStatus):
  // every 2s, up to ~2 min, until the proxy reports "ok" (success) or "error".
  // onPollOAuth refreshes the management snapshot on success, so the new account
  // appears without the user clicking "poll" manually.
  async function autoPollOAuth(state: string) {
    pollRef.current = state;
    let consecutiveFailures = 0;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      // Poll once immediately, then wait between polls — a fast authorization is
      // detected without an upfront 2s delay (mirrors the reference app).
      if (attempt > 0) {
        await new Promise((resolve) => window.setTimeout(resolve, 2000));
      }
      if (pollRef.current !== state) return; // superseded by a new auth, or unmounted
      const response = await onPollOAuth(state);
      if (pollRef.current !== state) return;
      if (!response) {
        // The status call itself failed (proxy down / bad management key). Tolerate
        // a few transient blips, but don't silently retry for the full 2 minutes.
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          setOAuthSession((current) =>
            current && current.state === state
              ? { ...current, status: "error", error: "无法获取授权状态（代理无响应或管理密钥不对），请重试。" }
              : current,
          );
          pollRef.current = null;
          return;
        }
        continue;
      }
      consecutiveFailures = 0;
      setOAuthSession((current) =>
        current && current.state === state ? { ...current, status: response.status, error: response.error } : current,
      );
      if (["ok", "success", "completed"].includes(response.status)) {
        pollRef.current = null;
        // Re-authorized — re-probe quotas so the account's "needs re-auth" marker
        // clears (and the new account shows) without waiting for the auto-poll.
        onRefreshQuotas();
        // This session's :1455 callback listener is now closed, so the auth link is
        // dead. Clear it so the user can't copy a stale link — adding another
        // account means clicking a provider again (which mints a fresh link + a
        // fresh :1455 listener). Reusing the old link is the #1 multi-account trap.
        setOAuthSession((current) =>
          current && current.state === state ? { ...current, url: null } : current,
        );
        return;
      }
      if (response.status === "error") {
        pollRef.current = null;
        return;
      }
    }
    setOAuthSession((current) =>
      current && current.state === state ? { ...current, status: "error", error: "OAuth 授权超时，请重试。" } : current,
    );
    pollRef.current = null;
  }

  // Start OAuth for a provider (shared by the chip grid and per-account re-auth).
  async function startProviderOAuth(provider: ProviderSummary) {
    setShowAdd(true);
    // is_webui=true is the mode that makes CLIProxyAPI bind its local Codex
    // callback listener on :1455 (verified directly: is_webui=false does NOT bind
    // it). The browser's redirect to localhost:1455 then lands on the proxy, which
    // performs the token exchange itself — the same flow the official Web UI uses.
    const response = await onStartOAuth(provider.oauth_endpoint ?? "", projectId, true);
    if (!response) return;
    setOAuthSession({
      providerName: provider.display_name,
      url: response.url,
      state: response.state,
      status: response.status,
      error: response.error,
    });
    if (response.url) void openAuthUrl(response.url);
    if (response.state && !response.error) void autoPollOAuth(response.state);
  }

  // Re-authorize a specific account by re-running its provider's OAuth login.
  function reauthAccount(account: AuthFile) {
    const provider = appState.providers.find(
      (item) => item.id === account.provider || item.id.includes(account.provider) || account.provider.includes(item.id),
    );
    if (provider?.oauth_endpoint) void startProviderOAuth(provider);
  }

  function resetCustomForm() {
    setCustomForm({ name: "", base_url: "", api_key: "", kind: "openai", prefix: "" });
    setEditingCustomId(null);
    setShowAddCustom(false);
  }

  function startEditCustom(provider: CustomProvider) {
    setCustomForm({
      name: provider.name,
      base_url: provider.base_url,
      api_key: provider.api_key,
      kind: provider.kind || "openai",
      prefix: provider.prefix ?? "",
    });
    setEditingCustomId(provider.id);
    setShowAddCustom(true);
  }

  async function submitCustomProvider() {
    if (!customForm.name.trim() || !customForm.base_url.trim()) return;
    try {
      const command = editingCustomId ? "update_custom_provider" : "add_custom_provider";
      const args = editingCustomId ? { id: editingCustomId, ...customForm } : customForm;
      setCustomProviders(await invoke<CustomProvider[]>(command, args));
      resetCustomForm();
    } catch {
      /* surfaced elsewhere */
    }
  }

  async function removeCustomProvider(id: string) {
    try {
      setCustomProviders(await invoke<CustomProvider[]>("delete_custom_provider", { id }));
      if (editingCustomId === id) resetCustomForm();
    } catch {
      /* ignore */
    }
  }

  async function onImportFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    if (files.length === 0) return;
    for (const file of files) {
      try {
        const content = await file.text();
        await invoke("import_auth_file", { filename: file.name, content });
      } catch {
        /* skip invalid files */
      }
    }
    onRefreshManagement();
    if ("__TAURI_INTERNALS__" in window) {
      try {
        setLocalAccounts(await invoke<AuthFile[]>("list_local_accounts"));
      } catch {
        /* ignore */
      }
    }
  }

  return (
    <section className="section-page providers-page">
      <header className="page-topbar" data-tauri-drag-region>
        <h1>{t("nav.providers")}</h1>
        <div className="topbar-actions">
          <button
            className="icon-button"
            type="button"
            onClick={onRefreshQuotas}
            disabled={isManagementBusy}
            title="刷新账号(重新检测)"
            aria-label="刷新账号"
          >
            <RefreshIcon />
          </button>
        </div>
      </header>

      {showAdd ? (
        <section className="section-grid providers-add-grid">
          <OAuthPanel
            providers={oauthProviders}
            projectId={projectId}
            oauthSession={oauthSession}
            isBusy={isManagementBusy}
            managementAction={managementAction}
            onProjectIdChange={setProjectId}
            onStartOAuth={(provider) => void startProviderOAuth(provider)}
            onPollOAuth={async () => {
              if (!oauthSession?.state) return;
              const response = await onPollOAuth(oauthSession.state);
              if (!response) return;
              setOAuthSession({ ...oauthSession, status: response.status, error: response.error });
            }}
            onCancel={() => {
              pollRef.current = null;
              setOAuthSession(null);
            }}
          />

          <VertexImportPanel
            provider={vertexProvider}
            value={vertexJson}
            error={vertexError}
            isBusy={isManagementBusy}
            onChange={(value) => {
              setVertexJson(value);
              setVertexError(null);
            }}
            onImport={() => {
              const value = vertexJson.trim();
              if (!value) return;
              try {
                JSON.parse(value);
              } catch {
                setVertexError("JSON 格式不合法。");
                return;
              }
              onRunManagementStateAction("import_management_vertex_service_account", { json: value });
              setVertexJson("");
            }}
          />
        </section>
      ) : null}

      <article className="panel accounts-panel">
        <div className="panel-label">
          <span className="eyebrow">{t("providers.yourAccounts")}</span>
          <span className="accounts-panel-right">
            <button
              className={showAdd ? "ghost-action ghost-action--active" : "ghost-action"}
              type="button"
              onClick={() => setShowAdd((value) => !value)}
            >
              {showAdd ? t("providers.closeOAuth") : t("providers.openOAuth")}
            </button>
            <label className="ghost-action import-pick" title={t("import.desc")}>
              {t("import.button")}
              <input
                type="file"
                accept=".json,application/json"
                multiple
                hidden
                disabled={isManagementBusy}
                onChange={onImportFiles}
              />
            </label>
            {authFiles.length > 0 ? (
              <button
                className="ghost-action"
                type="button"
                disabled={isManagementBusy}
                style={confirmClearAll ? { color: "#dc2626", fontWeight: 600 } : undefined}
                title="清空全部账号"
                onClick={() => {
                  if (confirmClearAll) {
                    setConfirmClearAll(false);
                    onRunManagementStateAction("delete_all_management_auth_files");
                  } else {
                    setConfirmClearAll(true);
                    window.setTimeout(() => setConfirmClearAll(false), 4000);
                  }
                }}
              >
                {confirmClearAll ? `确认清空 ${authFiles.length} 个？` : "清空"}
              </button>
            ) : null}
            <span className="count-pill">{authFiles.length}</span>
          </span>
        </div>

        {groups.length === 0 ? (
          <p className="empty-copy">暂无账号快照。点击右上角 + 通过 OAuth 授权或导入 Service Account 添加账号。</p>
        ) : (
          <div className="account-groups">
            {groups.map((group) => (
              <AccountGroup
                key={group.id}
                group={group}
                isBusy={isManagementBusy}
                authFailedNames={authFailedNames}
                authHealth={authHealth}
                onDelete={(account) => onRunManagementStateAction("delete_management_auth_file", { name: account.name })}
                onReauth={reauthAccount}
              />
            ))}
          </div>
        )}
      </article>

      <article className="panel">
        <div className="panel-label">
          <span className="eyebrow">{t("providers.customProviders")}</span>
          <button
            className={showAddCustom ? "icon-button icon-button--active" : "icon-button"}
            type="button"
            onClick={() => (showAddCustom ? resetCustomForm() : setShowAddCustom(true))}
            title={t("providers.addCustom")}
            aria-label={t("providers.addCustom")}
          >
            <PlusIcon />
          </button>
        </div>

        {showAddCustom ? (
          <div className="stacked-form custom-provider-form">
            <label>
              {t("providers.cpName")}
              <input
                value={customForm.name}
                onChange={(event) => setCustomForm({ ...customForm, name: event.target.value })}
                placeholder="My Provider"
              />
            </label>
            <label>
              {t("providers.cpBaseUrl")}
              <input
                value={customForm.base_url}
                onChange={(event) => setCustomForm({ ...customForm, base_url: event.target.value })}
                placeholder="https://api.example.com/v1"
              />
            </label>
            <label>
              {t("providers.cpApiKey")}
              <input
                type="password"
                value={customForm.api_key}
                onChange={(event) => setCustomForm({ ...customForm, api_key: event.target.value })}
                placeholder="sk-..."
              />
            </label>
            <label>
              {t("providers.cpKind")}
              <Select
                value={customForm.kind}
                options={[
                  { value: "openai", label: "OpenAI" },
                  { value: "gemini", label: "Gemini" },
                ]}
                onChange={(value) => setCustomForm({ ...customForm, kind: value })}
              />
            </label>
            <label>
              {t("providers.cpPrefix")}
              <input
                value={customForm.prefix}
                onChange={(event) => setCustomForm({ ...customForm, prefix: event.target.value })}
                placeholder="myprovider"
              />
            </label>
            <button
              className="primary-action"
              type="button"
              onClick={() => void submitCustomProvider()}
              disabled={!customForm.name.trim() || !customForm.base_url.trim()}
            >
              {editingCustomId ? t("providers.cpSave") : t("providers.cpAdd")}
            </button>
          </div>
        ) : null}

        {customProviders.length === 0 ? (
          <p className="empty-copy">导入自定义 OpenAI / Gemini 兼容端点。点击右上角 + 添加。</p>
        ) : (
          <div className="custom-provider-list">
            {customProviders.map((provider) => (
              <div className="custom-provider-row" key={provider.id}>
                <div className="custom-provider-info">
                  <strong>{provider.name}</strong>
                  <small>{provider.base_url}</small>
                </div>
                <span className="custom-provider-kind">{provider.kind}</span>
                <button
                  className="row-icon-btn"
                  type="button"
                  onClick={() => startEditCustom(provider)}
                  title={t("providers.cpEdit")}
                  aria-label={t("providers.cpEdit")}
                >
                  ✎
                </button>
                <button
                  className="row-icon-btn row-icon-btn--danger"
                  type="button"
                  onClick={() => void removeCustomProvider(provider.id)}
                  title="删除"
                  aria-label="删除"
                >
                  <TrashIcon />
                </button>
              </div>
            ))}
          </div>
        )}
      </article>
    </section>
  );
}

// Per-account state for the Providers badge, derived from the proxy's flags +
// the recent-request health (no live `status` string guessing). `needsReauth`
// surfaces the re-auth button and floats the account to the top of its group.
type AccountStateInfo = { tone: "good" | "warn" | "bad" | "muted"; key: string; fallback: string; needsReauth: boolean };

// Look up an account's usage-store health by its email/account label (the usage
// event `source`); the filename (`name`) is never the source, so it's skipped.
function healthFor(
  account: AuthFile,
  authHealth: Map<string, AccountAuthHealth>,
): AccountAuthHealth | undefined {
  for (const candidate of [account.email, account.account, account.label]) {
    if (candidate) {
      const found = authHealth.get(candidate.trim().toLowerCase());
      if (found) return found;
    }
  }
  return undefined;
}

function accountState(
  account: AuthFile,
  authFailed: boolean,
  health: AccountAuthHealth | undefined,
): AccountStateInfo {
  // Re-auth is suggested ONLY on genuine auth failures:
  //   1. the quota probe's unrecoverable 401 (durable, survives restarts), or
  //   2. recent requests dominated by real 401/403 with no success (from the
  //      persisted status codes — how cpa-manager judges a "real 401").
  // A blanket recent-failure count or the proxy's vague "error" status no longer
  // triggers re-auth, since 500/429 failures are rate-limit/transient, not auth.
  if (authFailed) return { tone: "bad", key: "providers.stateNeedsReauth", fallback: "需重新授权", needsReauth: true };
  if (health?.recommend_reauth) return { tone: "bad", key: "providers.stateNeedsReauth", fallback: "需重新授权", needsReauth: true };
  if (account.disabled) return { tone: "muted", key: "providers.statusDisabled", fallback: "已禁用", needsReauth: false };
  if (account.unavailable) return { tone: "bad", key: "providers.stateUnavailable", fallback: "不可用", needsReauth: true };
  const status = (account.status ?? "").trim().toLowerCase();
  if (status === "cooling") return { tone: "warn", key: "providers.stateCooling", fallback: "冷却中", needsReauth: false };

  // Classify by REAL status codes when usage history exists (preferred).
  if (health && health.recent_total > 0) {
    const failures = health.auth_failures + health.rate_limited + health.server_errors;
    if (failures === 0) return { tone: "good", key: "providers.stateActive", fallback: "正常", needsReauth: false };
    if (health.rate_limited > 0 && health.rate_limited >= health.server_errors && health.rate_limited >= health.auth_failures)
      return { tone: "warn", key: "providers.stateRateLimited", fallback: "限流", needsReauth: false };
    if (failures >= health.successes)
      return { tone: "bad", key: "providers.stateFailing", fallback: "异常 · 失败偏多", needsReauth: false };
    return { tone: "warn", key: "providers.stateDegraded", fallback: "部分失败", needsReauth: false };
  }

  // Fallback to the proxy's recent-request buckets when there's no usage history
  // yet (e.g. right after a fresh start) — still without claiming an auth issue.
  const recent = account.recent_requests ?? [];
  const ok = recent.reduce((sum, bucket) => sum + bucket.success, 0);
  const fail = recent.reduce((sum, bucket) => sum + bucket.failed, 0);
  if (fail >= 3 && fail >= ok) return { tone: "bad", key: "providers.stateFailing", fallback: "异常 · 失败偏多", needsReauth: false };
  if (fail > 0) return { tone: "warn", key: "providers.stateDegraded", fallback: "部分失败", needsReauth: false };
  if (status === "error") return { tone: "bad", key: "providers.stateAnomaly", fallback: "异常", needsReauth: false };
  return { tone: "good", key: "providers.stateActive", fallback: "正常", needsReauth: false };
}

function AccountGroup({
  group,
  isBusy,
  authFailedNames,
  authHealth,
  onDelete,
  onReauth,
}: {
  group: AccountGroupData;
  isBusy: boolean;
  authFailedNames: Set<string>;
  authHealth: Map<string, AccountAuthHealth>;
  onDelete: (account: AuthFile) => void;
  onReauth: (account: AuthFile) => void;
}) {
  const [open, setOpen] = useState(true);
  const initial = group.label.trim().charAt(0).toUpperCase() || "?";
  // Float accounts needing re-auth to the top so they're easy to spot/fix.
  // Compute each account's state once (not twice per comparison) before sorting.
  const accounts = group.accounts
    .map((account) => ({
      account,
      needsReauth: accountState(account, authFailedNames.has(account.name), healthFor(account, authHealth)).needsReauth,
    }))
    .sort((a, b) => Number(b.needsReauth) - Number(a.needsReauth))
    .map((entry) => entry.account);

  return (
    <div className="account-group">
      <button className="account-group-head" type="button" onClick={() => setOpen((value) => !value)}>
        <span className={open ? "group-chevron group-chevron--open" : "group-chevron"} aria-hidden="true">
          ›
        </span>
        <span className="account-logo" style={{ color: `#${group.colorHex}`, background: `#${group.colorHex}22` }} aria-hidden="true">
          {initial}
        </span>
        <span className="account-group-name">{group.label}</span>
        <span className="account-group-count">{group.accounts.length}</span>
      </button>

      {open ? (
        <div className="account-rows">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              colorHex={group.colorHex}
              isBusy={isBusy}
              authFailed={authFailedNames.has(account.name)}
              health={healthFor(account, authHealth)}
              onDelete={() => onDelete(account)}
              onReauth={() => onReauth(account)}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

type AccountRowProps = {
  account: AuthFile;
  colorHex: string;
  isBusy: boolean;
  authFailed: boolean;
  health: AccountAuthHealth | undefined;
  onDelete: () => void;
  onReauth: () => void;
};

// Signature of the bits of account health that affect the rendered badge.
function healthSignature(health: AccountAuthHealth | undefined): string {
  if (!health) return "none";
  return `${health.recommend_reauth ? 1 : 0}|${health.auth_failures}|${health.rate_limited}|${health.server_errors}|${health.successes}`;
}

// Sum of the recent success/failed buckets — the only part of `recent_requests`
// that affects the rendered status badge.
function recentRequestsSignature(recent: AuthFile["recent_requests"]): string {
  if (!recent || recent.length === 0) return "0";
  let ok = 0;
  let fail = 0;
  for (const bucket of recent) {
    ok += bucket.success;
    fail += bucket.failed;
  }
  return `${ok}/${fail}`;
}

// Skip re-rendering a row when its rendered data is unchanged, even though the
// account object + handler closures are new on every poll tick. The function
// props (onDelete/onReauth) are intentionally ignored — they only ever act on
// the account's stable name/provider.
function areAccountRowPropsEqual(a: AccountRowProps, b: AccountRowProps): boolean {
  if (a.colorHex !== b.colorHex || a.isBusy !== b.isBusy || a.authFailed !== b.authFailed) {
    return false;
  }
  if (healthSignature(a.health) !== healthSignature(b.health)) {
    return false;
  }
  const x = a.account;
  const y = b.account;
  return (
    x.name === y.name &&
    x.email === y.email &&
    x.account === y.account &&
    x.label === y.label &&
    x.disabled === y.disabled &&
    x.unavailable === y.unavailable &&
    x.status === y.status &&
    recentRequestsSignature(x.recent_requests) === recentRequestsSignature(y.recent_requests)
  );
}

const AccountRow = memo(function AccountRow({
  account,
  colorHex,
  isBusy,
  authFailed,
  health,
  onDelete,
  onReauth,
}: AccountRowProps) {
  const t = useT();
  const label = account.email || account.account || account.label || account.name;
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  const state = accountState(account, authFailed, health);

  return (
    <div className="account-row">
      <span className="account-logo account-logo--sm" style={{ color: `#${colorHex}`, background: `#${colorHex}22` }} aria-hidden="true">
        {initial}
      </span>
      <div className="account-row-info">
        <span className="account-row-email">{maskEmail(label)}</span>
        <span className={`account-row-status account-row-status--${state.tone}`}>{t(state.key, state.fallback)}</span>
      </div>
      <div className="account-row-actions">
        {state.needsReauth ? (
          <button className="account-reauth-btn" type="button" onClick={onReauth} disabled={isBusy}>
            {t("providers.reauth", "重新授权")}
          </button>
        ) : null}
        <button className="row-icon-btn row-icon-btn--danger" type="button" onClick={onDelete} disabled={isBusy} title="删除账号" aria-label="删除账号">
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}, areAccountRowPropsEqual);

function groupAccounts(authFiles: AuthFile[], providers: ProviderSummary[]): AccountGroupData[] {
  const groups: AccountGroupData[] = [];
  const index = new Map<string, number>();

  for (const account of authFiles) {
    let position = index.get(account.provider);
    if (position === undefined) {
      const provider = providers.find((item) => item.id === account.provider || item.id.includes(account.provider));
      position = groups.length;
      index.set(account.provider, position);
      groups.push({
        id: account.provider,
        label: provider?.display_name ?? account.provider,
        colorHex: provider?.color_hex ?? "8a8a8e",
        accounts: [],
      });
    }
    groups[position].accounts.push(account);
  }

  return groups;
}

function OAuthPanel({
  providers,
  projectId,
  oauthSession,
  isBusy,
  managementAction,
  onProjectIdChange,
  onStartOAuth,
  onPollOAuth,
  onCancel,
}: {
  providers: ProviderSummary[];
  projectId: string;
  oauthSession: OAuthSession | null;
  isBusy: boolean;
  managementAction: string | null;
  onProjectIdChange: (value: string) => void;
  onStartOAuth: (provider: ProviderSummary) => void;
  onPollOAuth: () => void;
  onCancel?: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [manualCallback, setManualCallback] = useState("");
  const [callbackBusy, setCallbackBusy] = useState(false);
  const [callbackError, setCallbackError] = useState<string | null>(null);
  async function copyAuthUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable (e.g. non-secure context) — user can still open it */
    }
  }
  async function submitManualCallback() {
    const value = manualCallback.trim();
    if (!value) return;
    setCallbackBusy(true);
    setCallbackError(null);
    try {
      await invoke("submit_oauth_callback", { url: value });
      setManualCallback("");
      onPollOAuth(); // re-check status now that the proxy received the code
    } catch (error) {
      setCallbackError(String(error));
    } finally {
      setCallbackBusy(false);
    }
  }
  return (
    <article className="panel section-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">OAuth</p>
          <h2>授权入口</h2>
        </div>
        <span className="count-pill">{providers.length} providers</span>
      </div>

      <div className="stacked-form">
        <label>
          Project ID，可选
          <input value={projectId} onChange={(event) => onProjectIdChange(event.target.value)} placeholder="Google / Vertex project id" />
        </label>
      </div>

      <div className="provider-chip-grid">
        {providers.map((provider) => (
          <button
            className="provider-chip provider-chip--button"
            key={provider.id}
            type="button"
            onClick={() => onStartOAuth(provider)}
            disabled={isBusy || !provider.oauth_endpoint}
          >
            <span className="provider-dot" style={{ backgroundColor: `#${provider.color_hex}` }} />
            <span>
              <strong>{provider.display_name}</strong>
              <small>{provider.oauth_endpoint}</small>
            </span>
          </button>
        ))}
      </div>

      {oauthSession ? (
        <div className="oauth-session-card">
          <div className="oauth-session-head">
            <strong>{oauthSession.providerName}</strong>
            <span className={`oauth-status oauth-status--${oauthSession.status}`}>{oauthSession.status}</span>
          </div>
          {["ok", "success", "completed"].includes(oauthSession.status) ? (
            <p style={{ margin: "4px 0 8px", fontSize: 13, color: "#16a34a", lineHeight: 1.5 }}>
              ✅ 账号已添加。再加一个号:点上方 provider <strong>重新授权</strong>(会生成新链接);不同账号请用<strong>隐身窗口</strong>登录,避免串号。
            </p>
          ) : null}
          {oauthSession.error ? <p className="inline-error">{oauthSession.error}</p> : null}
          {oauthSession.url ? (
            <div className="oauth-url-row" style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
              <input
                className="oauth-url-input"
                type="text"
                readOnly
                value={oauthSession.url}
                onFocus={(event) => event.currentTarget.select()}
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                className="secondary-action"
                type="button"
                onClick={() => void copyAuthUrl(oauthSession.url!)}
                title="复制授权链接（可粘到隐身窗口用其它账号登录）"
              >
                {copied ? "已复制" : "复制链接"}
              </button>
            </div>
          ) : null}
          {oauthSession.url ? (
            <p style={{ margin: "0 0 8px", fontSize: 12, opacity: 0.72, lineHeight: 1.5 }}>
              💡 添加<strong>其它账号</strong>时:点"复制链接",在浏览器的<strong>隐身/无痕窗口</strong>打开并登录该账号——否则会复用当前已登录的账号,导致串号。
            </p>
          ) : null}
          {oauthSession.state ? <code className="oauth-token">{oauthSession.state}</code> : null}
          <div className="oauth-session-actions">
            {oauthSession.url ? (
              <a className="secondary-action" href={oauthSession.url} target="_blank" rel="noreferrer">
                在浏览器中打开
              </a>
            ) : null}
            <button className="primary-action" type="button" onClick={onPollOAuth} disabled={isBusy || !oauthSession.state}>
              {managementAction === "poll_management_oauth" ? "轮询中..." : "轮询授权状态"}
            </button>
            <button className="secondary-action" type="button" onClick={() => onCancel?.()}>
              取消
            </button>
          </div>
          <div className="oauth-manual-callback" style={{ marginTop: 10 }}>
            <p style={{ margin: "0 0 6px", fontSize: 12, opacity: 0.75 }}>
              自动回调没完成？把浏览器里的回调地址（http://localhost:1455/...&amp;code=...）粘到这里手动完成：
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <input
                type="text"
                placeholder="http://localhost:1455/auth/callback?code=...&amp;state=..."
                value={manualCallback}
                onChange={(event) => setManualCallback(event.target.value)}
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                className="secondary-action"
                type="button"
                disabled={isBusy || callbackBusy || manualCallback.trim().length === 0}
                onClick={() => void submitManualCallback()}
              >
                {callbackBusy ? "提交中..." : "我已授权，提交"}
              </button>
            </div>
            {callbackError ? <p className="inline-error" style={{ marginTop: 6 }}>{callbackError}</p> : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

function VertexImportPanel({
  provider,
  value,
  error,
  isBusy,
  onChange,
  onImport,
}: {
  provider: ProviderSummary | undefined;
  value: string;
  error: string | null;
  isBusy: boolean;
  onChange: (value: string) => void;
  onImport: () => void;
}) {
  return (
    <article className="panel section-panel">
      <div className="panel-header">
        <div>
          <p className="eyebrow">Vertex</p>
          <h2>Service Account 导入</h2>
        </div>
        <span className="count-pill">{provider?.display_name ?? "Vertex AI"}</span>
      </div>

      <div className="stacked-form">
        <label>
          Service account JSON
          <textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            placeholder='{"type":"service_account",...}'
            rows={9}
          />
        </label>
        {error ? <p className="inline-error">{error}</p> : null}
        <button className="secondary-action" type="button" onClick={onImport} disabled={isBusy || value.trim().length === 0}>
          导入 Vertex JSON
        </button>
      </div>
    </article>
  );
}
