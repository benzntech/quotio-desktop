import { describe, expect, it, vi } from "vitest";
import {
  createMfaRecordId,
  dedupeMfaRecordsBySecret,
  getMfaOtpToken,
  getMfaTimeRemaining,
  normalizeStrictBase32,
  parseMfaCredentialInput,
  toMfaSecretIdentity,
  type MfaRecord,
} from "./mfaVault";

describe("mfaVault", () => {
  it("normalizes strict base32 secrets", () => {
    expect(normalizeStrictBase32(" abcd-2345 ")).toBe("ABCD2345");
    expect(normalizeStrictBase32("not valid!")).toBeNull();
  });

  it("parses otpauth totp uri and extracts display name", () => {
    const parsed = parseMfaCredentialInput("otpauth://totp/GitHub:user@example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub");
    expect(parsed).toEqual({ accountName: "GitHub:user@example.com", secret: "JBSWY3DPEHPK3PXP" });
  });

  it("parses raw base32 secret", () => {
    const parsed = parseMfaCredentialInput("JBSW Y3DP-EHPK3PXP");
    expect(parsed).toEqual({ accountName: "", secret: "JBSW Y3DP-EHPK3PXP" });
  });

  it("generates deterministic token when system time is fixed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
    expect(getMfaOtpToken("JBSWY3DPEHPK3PXP")).toMatch(/^\d{6}$/);
    vi.useRealTimers();
  });

  it("computes countdown from current unix time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(40_000));
    expect(getMfaTimeRemaining()).toBe(20);
    vi.useRealTimers();
  });

  it("dedupes records by normalized secret and keeps newest", () => {
    const records: MfaRecord[] = [
      { id: "old", accountName: "old", secret: "jbsw y3dp ehpk3pxp", time: 1 },
      { id: "new", accountName: "new", secret: "JBSWY3DPEHPK3PXP", time: 2 },
    ];
    expect(dedupeMfaRecordsBySecret(records)).toEqual([{ id: "new", accountName: "new", secret: "JBSWY3DPEHPK3PXP", time: 2 }]);
  });

  it("creates non-empty record ids", () => {
    expect(createMfaRecordId()).toMatch(/^mfa-|[0-9a-f-]{8}/i);
  });

  it("uses normalized identity for duplicate detection", () => {
    expect(toMfaSecretIdentity("jbsw-y3dp ehpk3pxp")).toBe("JBSWY3DPEHPK3PXP");
  });
});
