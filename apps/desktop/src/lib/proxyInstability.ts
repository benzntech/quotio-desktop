import type { AppState, RequestLogEntry } from "../types";

// How many of the most-recent request-log entries to weigh. `AppState.logs` is
// newest-first (usage_store.recent_events orders by timestamp DESC), so the head
// of the list is the recent window — no timestamp parsing needed.
const CONSIDER_RECENT = 20;

// Minimum upstream failures within that window before we surface the hint.
export const PROXY_INSTABILITY_MIN_FAILURES = 3;

// A failure that points at an unstable *upstream proxy / node* rather than the
// account: a transport death (no status, or 0) or a 5xx the core synthesised
// when the upstream connection was reset. 4xx (401/403 auth, 429 quota) are
// excluded on purpose — those aren't the proxy's fault and have their own cues.
function isUpstreamFailure(entry: RequestLogEntry): boolean {
  if (!entry.error_message) return false; // only failed requests carry this
  const status = entry.status_code;
  return status == null || status === 0 || status >= 500;
}

export type ProxyInstability = {
  failureCount: number;
  proxyUrl: string;
};

// Surface a hint only when an upstream proxy is actually configured (the
// reset-prone setup) AND several of the most recent requests died at the
// transport/5xx layer — i.e. the upstream proxy/node is dropping connections.
export function detectProxyInstability(state: AppState | null): ProxyInstability | null {
  if (!state) return null;
  const proxyUrl = state.settings.proxy_url?.trim();
  if (!proxyUrl) return null;
  const recent = (state.logs ?? []).slice(0, CONSIDER_RECENT);
  const failureCount = recent.filter(isUpstreamFailure).length;
  if (failureCount < PROXY_INSTABILITY_MIN_FAILURES) return null;
  return { failureCount, proxyUrl };
}
