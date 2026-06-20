//! CLIProxyAPI C-ABI **scheduler** plugin for Quotio.
//!
//! CLIProxyAPI routes by model name and treats `api-keys` as a flat allowlist —
//! it has no built-in "this key may only use that pool" gating. This plugin adds
//! it: on every auth pick the host hands us the inbound request headers (the
//! client api-key) plus the candidate pools, and we select the pool the key is
//! bound to — or deny the request when the key tries to reach a pool it isn't
//! bound to. Quotio writes the key→pool map into this plugin's config.
//!
//! Config (the `plugins.configs.quotio-key-router` subtree, delivered as YAML):
//! ```yaml
//! strict: true            # deny keys absent from `routes` (else fall through)
//! routes:
//!   - key: "sk-client-1"
//!     provider: "claude"          # match candidate.Provider (case-insensitive)
//!     base_url_contains: "28319"  # AND candidate.Attributes.base_url substring
//!   - key: "sk-client-2"
//!     provider: "codex"
//! ```

use std::ffi::{c_char, c_void, CStr};
use std::panic::catch_unwind;
use std::ptr;
use std::sync::{LazyLock, RwLock};

use base64::Engine;
use serde::Deserialize;
use serde_json::{json, Value};

const ABI_VERSION: u32 = 1;

// ---------------------------------------------------------------------------
// C ABI surface (mirrors examples/plugin/executor/rust)
// ---------------------------------------------------------------------------

#[repr(C)]
pub struct CliproxyBuffer {
    ptr: *mut u8,
    len: usize,
}

type HostCall = unsafe extern "C" fn(
    *mut c_void,
    *const c_char,
    *const u8,
    usize,
    *mut CliproxyBuffer,
) -> i32;
type HostFree = unsafe extern "C" fn(*mut c_void, usize);
type PluginCall =
    unsafe extern "C" fn(*const c_char, *const u8, usize, *mut CliproxyBuffer) -> i32;
type PluginFree = unsafe extern "C" fn(*mut c_void, usize);
type PluginShutdown = unsafe extern "C" fn();

#[repr(C)]
pub struct CliproxyHostApi {
    abi_version: u32,
    host_ctx: *mut c_void,
    call: Option<HostCall>,
    free_buffer: Option<HostFree>,
}

#[repr(C)]
pub struct CliproxyPluginApi {
    abi_version: u32,
    call: Option<PluginCall>,
    free_buffer: Option<PluginFree>,
    shutdown: Option<PluginShutdown>,
}

#[no_mangle]
pub extern "C" fn cliproxy_plugin_init(
    _host: *const CliproxyHostApi,
    plugin: *mut CliproxyPluginApi,
) -> i32 {
    if plugin.is_null() {
        return 1;
    }
    unsafe {
        (*plugin).abi_version = ABI_VERSION;
        (*plugin).call = Some(plugin_call);
        (*plugin).free_buffer = Some(plugin_free);
        (*plugin).shutdown = Some(plugin_shutdown);
    }
    0
}

unsafe extern "C" fn plugin_call(
    method: *const c_char,
    request: *const u8,
    request_len: usize,
    response: *mut CliproxyBuffer,
) -> i32 {
    if !response.is_null() {
        (*response).ptr = ptr::null_mut();
        (*response).len = 0;
    }
    if method.is_null() {
        write_response(response, &error_envelope("invalid_method", "method is required"));
        return 1;
    }
    let method = match CStr::from_ptr(method).to_str() {
        Ok(value) => value.to_string(),
        Err(_) => {
            write_response(response, &error_envelope("invalid_method", "method is not utf-8"));
            return 1;
        }
    };
    let req_bytes: Vec<u8> = if request.is_null() || request_len == 0 {
        Vec::new()
    } else {
        std::slice::from_raw_parts(request, request_len).to_vec()
    };

    // Never let a panic cross the FFI boundary.
    let result = catch_unwind(|| handle_method(&method, &req_bytes))
        .unwrap_or_else(|_| error_envelope("plugin_panic", "scheduler plugin panicked"));
    write_response(response, &result);
    0
}

unsafe extern "C" fn plugin_free(ptr: *mut c_void, len: usize) {
    if !ptr.is_null() {
        let _ = Vec::from_raw_parts(ptr as *mut u8, len, len);
    }
}

unsafe extern "C" fn plugin_shutdown() {}

fn write_response(response: *mut CliproxyBuffer, text: &str) {
    if response.is_null() {
        return;
    }
    let mut bytes = text.as_bytes().to_vec();
    let len = bytes.len();
    let ptr = bytes.as_mut_ptr();
    std::mem::forget(bytes);
    unsafe {
        (*response).ptr = ptr;
        (*response).len = len;
    }
}

// ---------------------------------------------------------------------------
// Plugin config + state
// ---------------------------------------------------------------------------

#[derive(Debug, Default, Deserialize)]
struct Config {
    #[serde(default)]
    strict: bool,
    #[serde(default)]
    routes: Vec<Route>,
}

#[derive(Debug, Clone, Deserialize)]
struct Route {
    key: String,
    #[serde(default)]
    provider: Option<String>,
    #[serde(default)]
    base_url_contains: Option<String>,
}

static CONFIG: LazyLock<RwLock<Config>> = LazyLock::new(|| RwLock::new(Config::default()));

// ---------------------------------------------------------------------------
// Method dispatch
// ---------------------------------------------------------------------------

fn handle_method(method: &str, request: &[u8]) -> String {
    match method {
        "plugin.register" | "plugin.reconfigure" => {
            configure(request);
            ok_envelope(registration())
        }
        "scheduler.pick" => pick_auth(request),
        _ => error_envelope("unknown_method", "unknown method"),
    }
}

/// Parse the `{ "config_yaml": "<base64 yaml>" }` lifecycle payload and store the
/// key→pool routes. Tolerant: any decode failure leaves an empty config.
fn configure(request: &[u8]) {
    let parsed = (|| -> Option<Config> {
        let value: Value = serde_json::from_slice(request).ok()?;
        let b64 = value.get("config_yaml")?.as_str()?;
        let yaml = base64::engine::general_purpose::STANDARD.decode(b64).ok()?;
        serde_yaml::from_slice::<Config>(&yaml).ok()
    })()
    .unwrap_or_default();

    if let Ok(mut guard) = CONFIG.write() {
        *guard = parsed;
    }
}

fn registration() -> Value {
    json!({
        "schema_version": 1,
        // The host's validPlugin() rejects empty Name/Version/Author/GitHubRepository.
        "metadata": {
            "Name": "quotio-key-router",
            "Version": "0.1.0",
            "Author": "quotio",
            "GitHubRepository": "https://github.com/quotio/quotio-key-router",
            "Logo": "https://example.invalid/quotio-key-router.png",
            "ConfigFields": []
        },
        "capabilities": { "scheduler": true }
    })
}

// ---------------------------------------------------------------------------
// Scheduler logic
// ---------------------------------------------------------------------------

fn pick_auth(request: &[u8]) -> String {
    let req: Value = match serde_json::from_slice(request) {
        Ok(value) => value,
        Err(_) => return error_envelope("invalid_request", "scheduler request is not json"),
    };
    let Ok(cfg) = CONFIG.read() else {
        return ok_envelope(json!({ "Handled": false }));
    };
    pick_with(&req, &cfg)
}

/// Pure routing decision over a parsed request + config (no global state).
fn pick_with(req: &Value, cfg: &Config) -> String {
    // No inbound key visible → defer to the host's default scheduler.
    let Some(key) = inbound_key(req) else {
        return ok_envelope(json!({ "Handled": false }));
    };

    let Some(route) = cfg.routes.iter().find(|route| route.key == key) else {
        // Key isn't mapped: deny under strict, otherwise let the host decide.
        return if cfg.strict {
            error_envelope("unknown_key", "api key is not bound to any pool")
        } else {
            ok_envelope(json!({ "Handled": false }))
        };
    };

    let empty = Vec::new();
    let candidates = req
        .get("Candidates")
        .and_then(Value::as_array)
        .unwrap_or(&empty);

    let matching: Vec<&Value> = candidates
        .iter()
        .filter(|candidate| candidate_matches(candidate, route))
        .collect();

    if matching.is_empty() {
        // The key is bound, but none of the pools serving this model is its pool —
        // a cross-pool request. Reject it.
        return error_envelope(
            "pool_forbidden",
            "this api key is not allowed to use the requested model's pool",
        );
    }

    // Every candidate is the key's pool and there is more than one account: hand
    // selection back to the host's built-in scheduler so it load-balances across
    // the pool (skipping exhausted/cooling accounts) instead of pinning to the
    // first one. Returning a fixed AuthID would defeat the multi-account pool.
    if matching.len() > 1 && matching.len() == candidates.len() {
        return ok_envelope(json!({ "DelegateBuiltin": "fill-first", "Handled": true }));
    }

    // Single option, or the pool is a subset of the candidates (another provider
    // also serves this model) — pick the bound pool explicitly to keep gating.
    let id = matching[0].get("ID").and_then(Value::as_str).unwrap_or("");
    ok_envelope(json!({ "AuthID": id, "Handled": true }))
}

/// Pull the client api-key from the request headers the host forwards.
fn inbound_key(req: &Value) -> Option<String> {
    let headers = req.get("Options")?.get("Headers")?;
    let header_first = |name: &str| -> Option<String> {
        headers
            .get(name)
            .and_then(Value::as_array)
            .and_then(|values| values.first())
            .and_then(Value::as_str)
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
    };

    if let Some(authorization) = header_first("Authorization") {
        let token = authorization
            .strip_prefix("Bearer ")
            .or_else(|| authorization.strip_prefix("bearer "))
            .unwrap_or(&authorization)
            .trim();
        if !token.is_empty() {
            return Some(token.to_string());
        }
    }
    header_first("X-Api-Key").or_else(|| header_first("X-Goog-Api-Key"))
}

/// A candidate pool matches a route when every constraint the route specifies
/// (provider, base_url substring) holds.
fn candidate_matches(candidate: &Value, route: &Route) -> bool {
    if let Some(provider) = route.provider.as_deref().filter(|p| !p.is_empty()) {
        let actual = candidate.get("Provider").and_then(Value::as_str).unwrap_or("");
        if !actual.eq_ignore_ascii_case(provider) {
            return false;
        }
    }
    if let Some(needle) = route.base_url_contains.as_deref().filter(|n| !n.is_empty()) {
        let base_url = candidate
            .get("Attributes")
            .and_then(|attrs| attrs.get("base_url"))
            .and_then(Value::as_str)
            .unwrap_or("");
        if !base_url.contains(needle) {
            return false;
        }
    }
    true
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

fn ok_envelope(result: Value) -> String {
    json!({ "ok": true, "result": result }).to_string()
}

fn error_envelope(code: &str, message: &str) -> String {
    json!({ "ok": false, "error": { "code": code, "message": message } }).to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pick(strict: bool, routes: Vec<Route>, headers: Value, candidates: Value) -> Value {
        let config = Config { strict, routes };
        let req = json!({
            "Options": { "Headers": headers },
            "Candidates": candidates,
        });
        serde_json::from_str(&pick_with(&req, &config)).unwrap()
    }

    fn route(key: &str, provider: Option<&str>, base_url_contains: Option<&str>) -> Route {
        Route {
            key: key.into(),
            provider: provider.map(Into::into),
            base_url_contains: base_url_contains.map(Into::into),
        }
    }

    #[test]
    fn routes_bound_key_to_its_pool() {
        let out = pick(
            true,
            vec![route("sk-n", Some("claude"), Some("28319"))],
            json!({ "Authorization": ["Bearer sk-n"] }),
            json!([
                { "ID": "kiro-auth", "Provider": "claude", "Attributes": { "base_url": "http://127.0.0.1:28319" } },
                { "ID": "real-claude", "Provider": "claude", "Attributes": { "base_url": "https://api.anthropic.com" } }
            ]),
        );
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["result"]["AuthID"], json!("kiro-auth"));
        assert_eq!(out["result"]["Handled"], json!(true));
    }

    #[test]
    fn delegates_to_host_when_pool_has_multiple_accounts() {
        // 3 codex accounts, all the key's pool → delegate so the host balances.
        let out = pick(
            true,
            vec![route("sk-codex", Some("codex"), None)],
            json!({ "Authorization": ["Bearer sk-codex"] }),
            json!([
                { "ID": "codex-1", "Provider": "codex", "Attributes": {} },
                { "ID": "codex-2", "Provider": "codex", "Attributes": {} },
                { "ID": "codex-3", "Provider": "codex", "Attributes": {} }
            ]),
        );
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["result"]["DelegateBuiltin"], json!("fill-first"));
        assert_eq!(out["result"]["Handled"], json!(true));
        assert!(out["result"].get("AuthID").is_none());
    }

    #[test]
    fn denies_cross_pool_access() {
        // sk-codex asks for a claude model — only the Kiro pool is a candidate.
        let out = pick(
            true,
            vec![route("sk-codex", Some("codex"), None)],
            json!({ "Authorization": ["Bearer sk-codex"] }),
            json!([{ "ID": "kiro-auth", "Provider": "claude", "Attributes": { "base_url": "http://127.0.0.1:28319" } }]),
        );
        assert_eq!(out["ok"], json!(false));
        assert_eq!(out["error"]["code"], json!("pool_forbidden"));
    }

    #[test]
    fn strict_denies_unknown_key() {
        let out = pick(
            true,
            vec![],
            json!({ "Authorization": ["Bearer sk-stranger"] }),
            json!([{ "ID": "any", "Provider": "claude", "Attributes": {} }]),
        );
        assert_eq!(out["ok"], json!(false));
        assert_eq!(out["error"]["code"], json!("unknown_key"));
    }

    #[test]
    fn non_strict_falls_through_for_unknown_key() {
        let out = pick(
            false,
            vec![],
            json!({ "Authorization": ["Bearer sk-stranger"] }),
            json!([{ "ID": "any", "Provider": "claude", "Attributes": {} }]),
        );
        assert_eq!(out["ok"], json!(true));
        assert_eq!(out["result"]["Handled"], json!(false));
    }

    #[test]
    fn reads_x_api_key_header() {
        let out = pick(
            true,
            vec![route("sk-n", Some("claude"), None)],
            json!({ "X-Api-Key": ["sk-n"] }),
            json!([{ "ID": "kiro-auth", "Provider": "claude", "Attributes": {} }]),
        );
        assert_eq!(out["result"]["AuthID"], json!("kiro-auth"));
    }
}
