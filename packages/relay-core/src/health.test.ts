import { describe, expect, it } from "vitest";
import {
  RELAY_BALANCE_CRITICAL_LAMPORTS,
  RELAY_BALANCE_WARNING_LAMPORTS,
  assessRelayBalance,
} from "./health.js";

describe("assessRelayBalance", () => {
  it("is critical when the next transfer might not be affordable", () => {
    const health = assessRelayBalance(RELAY_BALANCE_CRITICAL_LAMPORTS - 1);
    expect(health.level).toBe("critical");
    // `ok: false` is what makes an uptime monitor page someone; a warning must not.
    expect(health.ok).toBe(false);
  });

  it("warns, without failing, at a level that still leaves days of notice", () => {
    const health = assessRelayBalance(RELAY_BALANCE_WARNING_LAMPORTS - 1);
    expect(health.level).toBe("warning");
    expect(health.ok).toBe(true);
  });

  it("is fine above the warning threshold", () => {
    expect(assessRelayBalance(RELAY_BALANCE_WARNING_LAMPORTS).level).toBe("ok");
  });

  it("counts an empty wallet as zero remaining transfers", () => {
    const health = assessRelayBalance(0);
    expect(health.level).toBe("critical");
    expect(health.mintsRemaining).toBe(0);
  });

  it("reports transfers remaining, not just lamports", () => {
    // "0.004 SOL" means nothing to whoever reads the alert at 3am; "one more transfer" does.
    const health = assessRelayBalance(RELAY_BALANCE_CRITICAL_LAMPORTS);
    expect(health.mintsRemaining).toBe(2);
    expect(health.message).toContain("more transfers");
  });

  it("thresholds are derived from the real cost of a mint", () => {
    // used_nonce rent 867,621 + fee ~5,000 + token-account rent 2,039,280 for a first-time
    // recipient. If these ever stop matching the numbers in docs/go-live.md, one of them is wrong.
    expect(RELAY_BALANCE_CRITICAL_LAMPORTS).toBe((867_621 + 5_000 + 2_039_280) * 2);
    expect(RELAY_BALANCE_WARNING_LAMPORTS).toBe((867_621 + 5_000 + 2_039_280) * 10);
  });
});
