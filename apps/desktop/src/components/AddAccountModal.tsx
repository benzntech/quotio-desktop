import { useState, useEffect, useRef, type ChangeEvent } from "react";
import { Mfa2faQuickPanel } from "./Mfa2faQuickPanel";
import type { NativeOAuthCompleteResponse, NativeOAuthStartResponse, OAuthStatusResponse, OAuthUrlResponse, ProviderSummary } from "../types";
import { CheckIcon, CopyIcon, KeyIcon, PlusIcon, RefreshIcon } from "./icons";
import { invoke } from "../lib/tauri";

function GlobeIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M2 8h12M8 1.5c1.8 2 2.8 4 2.8 6.5S9.8 12.5 8 14.5M8 1.5C6.2 3.5 5.2 5.5 5.2 8s1 4.5 2.8 6.5" />
    </svg>
  );
}

function FileIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 1.5H4.5a1.5 1.5 0 0 0-1.5 1.5v10a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5V5.5L9 1.5z" />
      <path d="M9 1.5v4h4" />
    </svg>
  );
}

function XIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />
    </svg>
  );
}

function SpinnerIcon() {
  return (
    <svg className="aam-spinner" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
      <path d="M8 1.5A6.5 6.5 0 1 1 1.5 8" />
    </svg>
  );
}

type Tab = "oauth" | "token" | "import";

type AddAccountModalProps = {
  provider: ProviderSummary;
  projectId: string;
  onClose: () => void;
  onStartOAuth: (endpoint: string, projectId: string | null, isWebui?: boolean) => Promise<OAuthUrlResponse | null>;
  onPollOAuth: (token: string) => Promise<OAuthStatusResponse | null>;
  onRefreshQuotas: () => void;
  onImportFile: (e: ChangeEvent<HTMLInputElement>) => void;
};

export function AddAccountModal({
  provider,
  projectId,
  onClose,
  onStartOAuth,
  onPollOAuth,
  onRefreshQuotas,
  onImportFile,
}: AddAccountModalProps) {
  const hasNativeOAuth = Boolean(provider.native_oauth);
  const hasProxyOAuth = Boolean(provider.oauth_endpoint);
  const hasOAuth = hasNativeOAuth || hasProxyOAuth;
  const isVertex = provider.id === "vertex";
  const [tab, setTab] = useState<Tab>(hasOAuth ? "oauth" : "token");
  const nativeLoginRef = useRef<string | null>(null);
  const [isDeviceFlow, setIsDeviceFlow] = useState(false);
  const [deviceUserCode, setDeviceUserCode] = useState("");

  // OAuth state
  const [oauthUrl, setOauthUrl] = useState<string | null>(null);
  const [oauthStatus, setOauthStatus] = useState<"idle" | "preparing" | "ready" | "polling" | "exchanging" | "success" | "error">("idle");
  const [oauthError, setOauthError] = useState<string | null>(null);
  const [urlCopied, setUrlCopied] = useState(false);
  const pollRef = useRef<string | null>(null);

  // Token/JSON state
  const [tokenInput, setTokenInput] = useState("");
  const [importing, setImporting] = useState(false);
  const [importStatus, setImportStatus] = useState<"idle" | "success" | "error">("idle");
  const [importMessage, setImportMessage] = useState("");

  // Manual callback state
  const [manualCallback, setManualCallback] = useState("");
  const [callbackBusy, setCallbackBusy] = useState(false);

  // File input ref
  const fileRef = useRef<HTMLInputElement>(null);

  // Auto-prepare OAuth when tab opens
  useEffect(() => {
    if (tab === "oauth" && hasOAuth && oauthStatus === "idle") {
      void prepareOAuth();
    }
    return () => { pollRef.current = null; nativeLoginRef.current = null; };
  }, [tab]);

  // Auto-close modal on success after 1200ms
  useEffect(() => {
    if (oauthStatus !== "success") return;
    const timer = setTimeout(onClose, 1200);
    return () => clearTimeout(timer);
  }, [oauthStatus, onClose]);

  async function openAuthUrl(url: string) {
    try {
      if ("__TAURI_INTERNALS__" in window) {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(url);
        return;
      }
    } catch { /* fallback */ }
    window.open(url, "_blank", "noreferrer");
  }

  async function prepareOAuth() {
    setOauthStatus("preparing");
    setOauthError(null);

    if (hasNativeOAuth) {
      try {
        const res = await invoke<NativeOAuthStartResponse>("native_oauth_start", { providerId: provider.id });
        nativeLoginRef.current = res.login_id;
        setOauthUrl(res.auth_url);
        setOauthStatus("ready");
        if (res.flow === "device_code") {
          setIsDeviceFlow(true);
          setDeviceUserCode(res.user_code);
        }
        void startNativePolling(res.login_id);
      } catch (err) {
        setOauthStatus("error");
        setOauthError(String(err));
      }
      return;
    }

    const response = await onStartOAuth(provider.oauth_endpoint ?? "", projectId, true);
    if (!response) {
      setOauthStatus("error");
      setOauthError("Unable to fetch auth link, please check proxy status and try again.");
      return;
    }
    if (response.error) {
      setOauthStatus("error");
      setOauthError(response.error);
      return;
    }
    setOauthUrl(response.url);
    setOauthStatus("ready");
    if (response.state) void startPolling(response.state);
  }

  async function startPolling(state: string) {
    pollRef.current = state;
    setOauthStatus("polling");
    let consecutiveFailures = 0;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
      if (pollRef.current !== state) return;
      const res = await onPollOAuth(state);
      if (pollRef.current !== state) return;
      if (!res) {
        consecutiveFailures++;
        if (consecutiveFailures >= 3) {
          setOauthStatus("error");
          setOauthError("Unable to fetch auth status (proxy unresponsive), please try again.");
          pollRef.current = null;
          return;
        }
        continue;
      }
      consecutiveFailures = 0;
      if (["ok", "success", "completed"].includes(res.status)) {
        setOauthStatus("success");
        pollRef.current = null;
        onRefreshQuotas();
        return;
      }
      if (res.status === "error") {
        setOauthStatus("error");
        setOauthError(res.error ?? "Auth failed.");
        pollRef.current = null;
        return;
      }
    }
    setOauthStatus("error");
    setOauthError("OAuth auth timed out, please try again.");
    pollRef.current = null;
  }

  async function startNativePolling(loginId: string) {
    nativeLoginRef.current = loginId;
    setOauthStatus("polling");
    for (let attempt = 0; attempt < 150; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, 2000));
      if (nativeLoginRef.current !== loginId) return;
      try {
        const res = await invoke<NativeOAuthCompleteResponse>("native_oauth_complete", { loginId });
        if (nativeLoginRef.current !== loginId) return;
        if (res.status === "success") {
          setOauthStatus("success");
          nativeLoginRef.current = null;
          onRefreshQuotas();
          return;
        }
        if (res.status === "error") {
          setOauthStatus("error");
          setOauthError(res.error ?? "Auth failed.");
          nativeLoginRef.current = null;
          return;
        }
      } catch (err) {
        setOauthStatus("error");
        setOauthError(`Auth completion failed: ${String(err)}`);
        nativeLoginRef.current = null;
        return;
      }
    }
    setOauthStatus("error");
    setOauthError("OAuth auth timed out, please try again.");
    nativeLoginRef.current = null;
  }

  function handleRetryOAuth() {
    pollRef.current = null;
    nativeLoginRef.current = null;
    setOauthUrl(null);
    setOauthStatus("idle");
    setOauthError(null);
    setIsDeviceFlow(false);
    setDeviceUserCode("");
    if (hasNativeOAuth) {
      invoke("native_oauth_cancel", { loginId: null }).catch(() => {});
    }
    void prepareOAuth();
  }

  async function handleCopyUrl() {
    if (!oauthUrl) return;
    try {
      await navigator.clipboard.writeText(oauthUrl);
      setUrlCopied(true);
      setTimeout(() => setUrlCopied(false), 1200);
    } catch { /* ignore */ }
  }

  async function handleManualCallback() {
    const url = manualCallback.trim();
    if (!url) return;
    setCallbackBusy(true);
    setOauthStatus("exchanging");
    try {
      if (hasNativeOAuth && nativeLoginRef.current) {
        await invoke("native_oauth_submit_callback", { loginId: nativeLoginRef.current, callbackUrl: url });
      } else {
        await invoke("submit_oauth_callback", { url });
      }
      setManualCallback("");
    } catch {
      setOauthStatus("error");
      setOauthError("Token exchange failed, please try again.");
    }
    setCallbackBusy(false);
  }

  async function handleTokenImport() {
    const value = tokenInput.trim();
    if (!value) return;
    setImporting(true);
    setImportStatus("idle");
    try {
      if (isVertex) {
        JSON.parse(value);
      }
      await invoke("import_auth_token", { providerId: provider.id, content: value });
      setImportStatus("success");
      setImportMessage("Import successful");
      setTokenInput("");
      onRefreshQuotas();
    } catch (err) {
      setImportStatus("error");
      setImportMessage(String(err) || "Import failed");
    }
    setImporting(false);
  }

  function switchTab(t: Tab) {
    pollRef.current = null;
    setTab(t);
    setImportStatus("idle");
    setImportMessage("");
  }

  return (
    <div className="modal-overlay aam-overlay" onClick={onClose}>
      <div className="aam-modal" onClick={(e) => e.stopPropagation()}>
        <div className="aam-header">
          <h2>Add Account</h2>
          <button className="aam-close" type="button" onClick={onClose}><XIcon /></button>
        </div>

        <div className="aam-tabs">
          {hasOAuth ? (
            <button className={`aam-tab${tab === "oauth" ? " aam-tab--active" : ""}`} type="button" onClick={() => switchTab("oauth")}>
              <GlobeIcon /> OAuth Auth
            </button>
          ) : null}
          <button className={`aam-tab${tab === "token" ? " aam-tab--active" : ""}`} type="button" onClick={() => switchTab("token")}>
            <KeyIcon /> Token / JSON
          </button>
          <button className={`aam-tab${tab === "import" ? " aam-tab--active" : ""}`} type="button" onClick={() => switchTab("import")}>
            <FileIcon /> Import
          </button>
        </div>

        <div className="aam-body">
          {tab === "oauth" && (
            <div className="aam-section">
              <div className="aam-hint-row">
                <GlobeIcon />
                <span>We recommend using your browser to complete {provider.display_name} authorization</span>
              </div>

              {oauthStatus === "error" && !oauthUrl ? (
                <div className="aam-status aam-status--error">
                  <span>{oauthError}</span>
                  <button className="aam-retry-btn" type="button" onClick={handleRetryOAuth}>
                    <RefreshIcon /> Regenerate Auth Info
                  </button>
                </div>
              ) : oauthUrl ? (
                <>
                  {isDeviceFlow && deviceUserCode ? (
                    <div className="aam-device-code">
                      <p className="aam-desc">Please open the link below in your browser and enter this verification code to complete authorization:</p>
                      <code className="aam-user-code">{deviceUserCode}</code>
                    </div>
                  ) : null}
                  <div className="aam-url-box">
                    <input type="text" readOnly value={oauthUrl} onFocus={(e) => e.currentTarget.select()} />
                    <button type="button" onClick={handleCopyUrl} title="Copy Link">
                      {urlCopied ? <CheckIcon /> : <CopyIcon />}
                    </button>
                  </div>
                  <button className="aam-primary-btn aam-primary-btn--full" type="button" onClick={() => void openAuthUrl(oauthUrl)}>
                    <GlobeIcon /> Open in Browser
                  </button>
                  {oauthStatus === "polling" && (
                    <div className="aam-status aam-status--loading">
                      <SpinnerIcon />
                      <span>Waiting for auth to complete, this window will update automatically...</span>
                    </div>
                  )}
                  {oauthStatus === "exchanging" && (
                    <div className="aam-status aam-status--loading">
                      <SpinnerIcon />
                      <span>Exchanging tokens...</span>
                    </div>
                  )}
                  {oauthStatus === "success" && (
                    <div className="aam-status aam-status--success">
                      <CheckIcon />
                      <span>Auth successful! Account added.</span>
                    </div>
                  )}
                  {oauthStatus === "error" && (
                    <div className="aam-status aam-status--error">
                      <span>{oauthError}</span>
                      <button className="aam-retry-btn" type="button" onClick={handleRetryOAuth}>
                        <RefreshIcon /> Refresh Auth Link
                      </button>
                    </div>
                  )}
                  <label className="aam-label">Manually enter callback URL</label>
                  <div className="aam-url-box">
                    <input
                      type="text"
                      placeholder="Paste full callback URL, e.g. http://localhost:1455/auth/callback?code=...&state=..."
                      value={manualCallback}
                      onChange={(e) => setManualCallback(e.target.value)}
                    />
                    <button className="aam-callback-btn" type="button" onClick={() => void handleManualCallback()} disabled={callbackBusy || !manualCallback.trim()}>
                      {callbackBusy ? <SpinnerIcon /> : <CheckIcon />}
                      <span>Submit</span>
                    </button>
                  </div>
                  <p className="aam-hint">This window will automatically update upon completing authorization.</p>
                </>
              ) : (
                <div className="aam-oauth-loading">
                  <SpinnerIcon />
                  <span>Preparing auth info...</span>
                </div>
              )}
            </div>
          )}

          {tab === "token" && (
            <div className="aam-section">
              <p className="aam-desc">
                {isVertex
                  ? "Paste Vertex AI Service Account JSON credentials."
                  : `Paste Token or JSON credentials for ${provider.display_name}.`}
              </p>
              <textarea
                className="aam-token-input"
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder={isVertex ? '{"type":"service_account",...}' : "Paste Token or JSON..."}
                rows={6}
              />
              <button className="aam-primary-btn" type="button" onClick={() => void handleTokenImport()} disabled={importing || !tokenInput.trim()}>
                {importing ? <SpinnerIcon /> : <PlusIcon />}
                Import
              </button>
            </div>
          )}

          {tab === "import" && (
            <div className="aam-section">
              <p className="aam-desc">Import auth credentials from a local JSON file.</p>
              <input ref={fileRef} type="file" accept=".json,application/json" multiple hidden onChange={(e) => { onImportFile(e); setImportStatus("success"); setImportMessage("File imported"); }} />
              <button className="aam-primary-btn" type="button" onClick={() => fileRef.current?.click()} disabled={importing}>
                <FileIcon /> Select JSON File to Import
              </button>
            </div>
          )}

          {importStatus !== "idle" ? (
            <div className={`aam-status aam-status--${importStatus}`}>
              {importStatus === "success" ? <CheckIcon /> : null}
              <span>{importMessage}</span>
            </div>
          ) : null}

          <Mfa2faQuickPanel />
        </div>
      </div>
    </div>
  );
}
