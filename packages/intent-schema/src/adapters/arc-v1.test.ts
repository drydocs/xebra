import { describe, expect, it } from "vitest";
import type { ArcLegacyIntent } from "../hash.js";
import { AssetKind, ChainId } from "../types.js";
import { arcLegacyToIntentV2, intentV2ToArcLegacy } from "./arc-v1.js";

const LEGACY: ArcLegacyIntent = {
  user: `0x${"71".repeat(20)}`,
  sourceToken: `0x${"19".repeat(20)}`,
  sourceAmount: 100_000000n,
  destAsset: `0x${"0".repeat(64)}`, // native XLM
  minDestAmount: 900_0000000n,
  destAddress: `0x${"7".repeat(64)}`,
  expiry: 2_000_000_000n,
  nonce: 1n,
};

describe("arc-v1 adapter", () => {
  it("round-trips a legacy intent through IntentV2 unchanged", () => {
    const v2 = arcLegacyToIntentV2(LEGACY);

    expect(v2.version).toBe(2);
    expect(v2.sourceChain).toBe(ChainId.ArcEvm);
    expect(v2.destChain).toBe(ChainId.Stellar);
    expect(v2.destAsset.kind).toBe(AssetKind.Native);
    expect(v2.sourceAmount).toBe(LEGACY.sourceAmount);
    expect(v2.nonce).toBe(LEGACY.nonce);

    const roundTripped = intentV2ToArcLegacy(v2);
    expect(roundTripped).toEqual(LEGACY);
  });

  it("preserves a non-native destAsset through the round trip", () => {
    const nonNative: ArcLegacyIntent = { ...LEGACY, destAsset: `0x${"ab".repeat(32)}` };
    const v2 = arcLegacyToIntentV2(nonNative);
    expect(v2.destAsset.kind).toBe(AssetKind.StellarClassicAsset);
    expect(intentV2ToArcLegacy(v2)).toEqual(nonNative);
  });

  it("rejects converting a non-Arc-source IntentV2 back to the legacy shape", () => {
    const v2 = arcLegacyToIntentV2(LEGACY);
    const wrongChain = { ...v2, sourceChain: ChainId.Stellar };
    expect(() => intentV2ToArcLegacy(wrongChain)).toThrow();
  });
});
