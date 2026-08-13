import { describe, expect, it } from "vitest";
import { type ArcLegacyIntent, hashArcIntent, stellarIntentHashNotReimplemented } from "./hash.js";

// Digit-only (no a-f) so these are valid regardless of EIP-55 checksum casing.
const USER = `0x${"71".repeat(20)}` as const;
const SOURCE_TOKEN = `0x${"19".repeat(20)}` as const;
const VERIFYING_CONTRACT_A = `0x${"22".repeat(20)}` as const;
const VERIFYING_CONTRACT_B = `0x${"33".repeat(20)}` as const;

const BASE_INTENT: ArcLegacyIntent = {
  user: USER,
  sourceToken: SOURCE_TOKEN,
  sourceAmount: 100_000000n,
  destAsset: `0x${"0".repeat(64)}`,
  minDestAmount: 900_0000000n,
  destAddress: `0x${"7".repeat(64)}`,
  expiry: 2_000_000_000n,
  nonce: 1n,
};

describe("hashArcIntent", () => {
  it("is deterministic for identical input", () => {
    const h1 = hashArcIntent(BASE_INTENT, 9001, VERIFYING_CONTRACT_A);
    const h2 = hashArcIntent(BASE_INTENT, 9001, VERIFYING_CONTRACT_A);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes when the verifying contract (deployed escrow address) changes", () => {
    const h1 = hashArcIntent(BASE_INTENT, 9001, VERIFYING_CONTRACT_A);
    const h2 = hashArcIntent(BASE_INTENT, 9001, VERIFYING_CONTRACT_B);
    expect(h1).not.toBe(h2);
  });

  it("changes when the chain id changes", () => {
    const h1 = hashArcIntent(BASE_INTENT, 9001, VERIFYING_CONTRACT_A);
    const h2 = hashArcIntent(BASE_INTENT, 1, VERIFYING_CONTRACT_A);
    expect(h1).not.toBe(h2);
  });

  it("changes when the nonce changes (replay protection depends on this)", () => {
    const h1 = hashArcIntent(BASE_INTENT, 9001, VERIFYING_CONTRACT_A);
    const h2 = hashArcIntent({ ...BASE_INTENT, nonce: 2n }, 9001, VERIFYING_CONTRACT_A);
    expect(h1).not.toBe(h2);
  });
});

describe("stellarIntentHashNotReimplemented", () => {
  it("refuses to fabricate a hash rather than silently drift from the on-chain XDR encoding", () => {
    expect(() => stellarIntentHashNotReimplemented()).toThrow(/hash_intent/);
  });
});
