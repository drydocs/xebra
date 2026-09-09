import { describe, expect, it } from "vitest";
import { type AdmissionDeps, DEFAULT_ADMISSION_POLICY, checkBurnAdmission } from "./admission.js";

const NOW = 1_700_000_000_000;
const HASH = "92421fa248da1b1d4418784d5bd91adc4238dae72120e8f740920db7381905a7";

function deps(overrides: Partial<AdmissionDeps> = {}): AdmissionDeps {
  return {
    burnClosedAt: async () => NOW - 5_000,
    countSponsoredSince: async () => 0,
    now: () => NOW,
    ...overrides,
  };
}

describe("checkBurnAdmission", () => {
  it("admits a burn submitted seconds ago", async () => {
    expect(await checkBurnAdmission(deps(), HASH)).toEqual({ admit: true });
  });

  it("refuses a burn older than the recency window", async () => {
    // Otherwise anyone can dump a backlog of strangers' historical burns into the queue and have
    // us pay 867,621 lamports of permanent rent for each.
    const result = await checkBurnAdmission(
      deps({ burnClosedAt: async () => NOW - 3 * 60 * 60 * 1000 }),
      HASH,
    );
    expect(result.admit).toBe(false);
    expect(result.reason).toContain("180 minutes old");
  });

  it("admits a burn right at the age limit", async () => {
    const at = deps({ burnClosedAt: async () => NOW - DEFAULT_ADMISSION_POLICY.maxAgeMs });
    expect((await checkBurnAdmission(at, HASH)).admit).toBe(true);
  });

  it("refuses a transaction Horizon does not know", async () => {
    // Sponsoring it means polling Iris for a message that will never arrive.
    const result = await checkBurnAdmission(deps({ burnClosedAt: async () => undefined }), HASH);
    expect(result.admit).toBe(false);
    expect(result.reason).toContain("not propagated");
  });

  it("stops sponsoring once the spend cap is reached", async () => {
    const result = await checkBurnAdmission(
      deps({ countSponsoredSince: async () => DEFAULT_ADMISSION_POLICY.maxMintsPerWindow }),
      HASH,
    );
    expect(result.admit).toBe(false);
    // The refusal has to say the funds are safe, because the caller has already burned.
    expect(result.reason).toContain("still claimable");
  });

  it("checks the cap before spending a Horizon round trip", async () => {
    // The cap is the cheap check and the one that matters when someone is flooding us.
    let horizonCalls = 0;
    await checkBurnAdmission(
      deps({
        countSponsoredSince: async () => 10_000,
        burnClosedAt: async () => {
          horizonCalls++;
          return NOW;
        },
      }),
      HASH,
    );
    expect(horizonCalls).toBe(0);
  });

  it("counts only the configured window", async () => {
    let requestedSince = 0;
    const recordWindow = async (since: number) => {
      requestedSince = since;
      return 0;
    };
    await checkBurnAdmission(deps({ countSponsoredSince: recordWindow }), HASH);
    expect(requestedSince).toBe(NOW - DEFAULT_ADMISSION_POLICY.windowMs);
  });

  it("treats a future close time as age zero rather than negative", async () => {
    // Clock skew between us and Horizon is not a reason to refuse a burn.
    expect(
      (await checkBurnAdmission(deps({ burnClosedAt: async () => NOW + 30_000 }), HASH)).admit,
    ).toBe(true);
  });
});
