import { describe, expect, it } from "vitest";
import {
  type FeeTier,
  minimumEvmAmount,
  planEvmFee,
  speedFeeFor,
  suggestedEvmMinimum,
} from "./evm-forward-fee";

const ARC = { name: "Arc", maxForwardFeeUnits: 100_000 };
const ETHEREUM = { name: "Ethereum", maxForwardFeeUnits: 5_000_000 };
// Iris, Base to Arc, 2026-10-09.
const STANDARD: FeeTier = { finalityThreshold: 2000, high: 16_778, minimumFeePpb: 0 };
const FAST: FeeTier = { finalityThreshold: 1000, high: 16_778, minimumFeePpb: 32_500 };

describe("speedFeeFor", () => {
  it("is zero for Standard", () => {
    expect(speedFeeFor(1_000_000_000n, 0)).toBe(0n);
  });

  it("is the quoted fraction of the amount", () => {
    // 0.325 bps of 1,000 USDC is 0.0325 USDC.
    expect(speedFeeFor(1_000_000_000n, 32_500)).toBe(32_500n);
  });

  it("rounds up, so the fee signed is never a unit short of the fee owed", () => {
    // 0.325 bps of 10 USDC is 325 units exactly; of 10.000001 it is 325.0000325.
    expect(speedFeeFor(10_000_000n, 32_500)).toBe(325n);
    expect(speedFeeFor(10_000_001n, 32_500)).toBe(326n);
    expect(speedFeeFor(1n, 32_500)).toBe(1n);
  });
});

describe("planEvmFee", () => {
  it("signs Circle's high delivery fee at 1.0x for Standard, and mints the rest", () => {
    expect(planEvmFee({ amount: 5_000_000n, tier: STANDARD, destination: ARC })).toEqual({
      ok: true,
      maxFee: 16_778n,
      deliveryFee: 16_778n,
      speedFee: 0n,
      received: 4_983_222n,
    });
  });

  it("adds the speed fee for Fast", () => {
    const plan = planEvmFee({ amount: 1_000_000_000n, tier: FAST, destination: ARC });
    expect(plan).toMatchObject({ ok: true, deliveryFee: 16_778n, speedFee: 32_500n });
    if (plan.ok) {
      expect(plan.maxFee).toBe(49_278n);
      expect(plan.received).toBe(1_000_000_000n - 49_278n);
    }
  });

  it("allows a delivery fee exactly at the destination's limit and refuses one unit over", () => {
    const at = { ...STANDARD, high: 100_000 };
    expect(planEvmFee({ amount: 50_000_000n, tier: at, destination: ARC }).ok).toBe(true);
    const over = planEvmFee({
      amount: 50_000_000n,
      tier: { ...STANDARD, high: 100_001 },
      destination: ARC,
    });
    expect(over.ok).toBe(false);
    if (!over.ok) {
      expect(over.kind).toBe("cap");
      expect(over.reason).toBe(
        "Circle's delivery fee (0.100001 USDC) is above the limit we allow for Arc right now (0.10 USDC). Try again shortly.",
      );
    }
  });

  it("gives a costlier destination its own, higher limit", () => {
    // Iris, Arc to Ethereum, 2026-10-09: about 1.38 USDC.
    const tier = { ...STANDARD, high: 1_376_978 };
    expect(planEvmFee({ amount: 50_000_000n, tier, destination: ETHEREUM }).ok).toBe(true);
    expect(planEvmFee({ amount: 50_000_000n, tier, destination: ARC }).ok).toBe(false);
  });

  it("refuses a transfer the fees would take more than a tenth of, and says how much to send", () => {
    const tiny = planEvmFee({ amount: 100_000n, tier: STANDARD, destination: ARC });
    expect(tiny.ok).toBe(false);
    if (!tiny.ok) {
      expect(tiny.kind).toBe("minimum");
      expect(tiny.reason).toBe(
        "Fees would take more than a tenth of this transfer. Send at least 0.18 USDC to Arc.",
      );
    }
  });

  it("applies the tenth rule exactly at the boundary", () => {
    // Fees of 16,778 are a tenth of 167,780.
    expect(planEvmFee({ amount: 167_780n, tier: STANDARD, destination: ARC }).ok).toBe(true);
    expect(planEvmFee({ amount: 167_779n, tier: STANDARD, destination: ARC }).ok).toBe(false);
  });

  it("refuses nothing-to-send and an unreadable quote in a sentence", () => {
    expect(planEvmFee({ amount: 0n, tier: STANDARD, destination: ARC })).toEqual({
      ok: false,
      kind: "amount",
      reason: "Enter an amount to send.",
    });
    const bad = planEvmFee({
      amount: 5_000_000n,
      tier: { ...STANDARD, high: 0 },
      destination: ARC,
    });
    expect(bad.ok).toBe(false);
  });
});

describe("minimumEvmAmount", () => {
  it("is the smallest amount the rule accepts, for either speed", () => {
    for (const tier of [STANDARD, FAST]) {
      const min = minimumEvmAmount(tier);
      expect(planEvmFee({ amount: min, tier, destination: ARC }).ok).toBe(true);
      expect(planEvmFee({ amount: min - 1n, tier, destination: ARC }).ok).toBe(false);
    }
    expect(minimumEvmAmount(STANDARD)).toBe(167_780n);
  });

  it("is about fourteen dollars to Ethereum at the fee Circle quoted", () => {
    const min = minimumEvmAmount({ ...STANDARD, high: 1_376_978 });
    expect(min).toBe(13_769_780n);
    expect(suggestedEvmMinimum(min)).toBe(14_460_000n);
  });
});
