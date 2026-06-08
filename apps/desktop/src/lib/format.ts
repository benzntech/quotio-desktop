// Small shared display helpers.
import type { AccountQuota, AuthFile } from "../types";

const HIDE_SENSITIVE_KEY = "quotio.hideSensitive";

// Whether sensitive values (emails, account names) should be masked in the UI.
// Controlled by the Settings > Privacy toggle, persisted in localStorage and
// defaulting to ON.
export function isHideSensitiveEnabled(): boolean {
  try {
    return localStorage.getItem(HIDE_SENSITIVE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function setHideSensitiveEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(HIDE_SENSITIVE_KEY, enabled ? "true" : "false");
  } catch {
    // ignore (e.g. storage unavailable)
  }
}

// Mask an email/identifier for the privacy-conscious UI, keeping the first 6
// characters visible (e.g. "aurora.b@gmail.com" -> "aurora•••@•••••.com").
// Returns the value unchanged when the privacy toggle is off. Falls back
// gracefully for non-email values.
const MASK_VISIBLE_PREFIX = 6;

export function maskEmail(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return trimmed;
  if (!isHideSensitiveEnabled()) return trimmed;

  const at = trimmed.indexOf("@");
  if (at <= 0) {
    // Non-email identifier: show the first 6 chars, mask the rest.
    return trimmed.length <= MASK_VISIBLE_PREFIX ? trimmed : `${trimmed.slice(0, MASK_VISIBLE_PREFIX)}${"•".repeat(3)}`;
  }

  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot >= 0 ? domain.slice(dot) : "";

  const visible = local.slice(0, MASK_VISIBLE_PREFIX);
  const maskedLocal = local.length > MASK_VISIBLE_PREFIX ? `${visible}${"•".repeat(3)}` : visible;
  return `${maskedLocal}@${"•".repeat(5)}${tld}`;
}

// Tone for a "remaining quota" percentage, matching the mock's color coding.
export function quotaTone(remainingPercent: number): "good" | "warn" | "bad" {
  if (remainingPercent <= 10) return "bad";
  if (remainingPercent <= 50) return "warn";
  return "good";
}

// Extract the subscription plan from an AccountQuota status_message, which the
// Codex / Copilot fetchers encode as "plan: <tier> | until: <date>".
export function parsePlan(statusMessage: string | null | undefined): string | null {
  if (!statusMessage) return null;
  return statusMessage.match(/plan:\s*([^|]+)/i)?.[1]?.trim() || null;
}

export type PlanTier = "free" | "plus" | "pro" | "team" | "business";

// Map a plan name to a tier key used for badge coloring (shared by the Quota
// page and the menu-bar panel so colors stay consistent).
export function planTier(plan: string): PlanTier {
  const value = plan.toLowerCase();
  if (/pro/.test(value)) return "pro";
  if (/team/.test(value)) return "team";
  if (/business|enterprise|edu/.test(value)) return "business";
  if (/free/.test(value)) return "free";
  return "plus";
}

// Match a quota account to a proxy auth-file (same provider, then email, then
// exact filename stem). Provider-scoping avoids cross-provider email collisions
// (e.g. the same email on Codex + Trae). Shared by gating and the health view.
export function matchAuthFile(quota: AccountQuota, authFiles: AuthFile[]): AuthFile | null {
  const provider = quota.provider_id.trim().toLowerCase();
  const candidates = authFiles.filter((file) => {
    const fp = (file.provider ?? "").trim().toLowerCase();
    return fp === provider || fp.includes(provider) || provider.includes(fp);
  });
  if (candidates.length === 0) return null;

  const email = quota.account_label?.trim().toLowerCase();
  if (email && email.includes("@")) {
    const byEmail = candidates.find((file) => (file.email ?? "").trim().toLowerCase() === email);
    if (byEmail) return byEmail;
  }
  const key = quota.account_key?.trim().toLowerCase();
  if (key) {
    const prefixed = `${provider}-${key}`;
    const byKey = candidates.find((file) => {
      const stem = file.name.toLowerCase().replace(/\.json$/, "");
      return stem === key || stem === prefixed;
    });
    if (byKey) return byKey;
  }
  return null;
}

// Tone for one recent-request health bucket: green (all ok), amber (mixed),
// red (all failed), gray (idle / no traffic).
export function healthTone(bucket: { success: number; failed: number }): "good" | "warn" | "bad" | "idle" {
  if (bucket.failed > 0) return bucket.success > 0 ? "warn" : "bad";
  return bucket.success > 0 ? "good" : "idle";
}
