import { splTokenAssetRef } from "@xebra/intent-schema";
import { describe, expect, it } from "vitest";
import { buildOpenIntentParams } from "./build-open-intent-params.js";

const DEST_ASSET = splTokenAssetRef("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const BASE_INPUT = {
  escrowContractId: "CESCROW",
  sorobanRpcUrl: "http://localhost:8000/soroban/rpc",
  networkPassphrase: "Test SDF Network ; September 2015",
  sourceTokenAddress: "CUSDC",
  userAddress: "GUSER",
  sourceAmountHuman: "100",
  destAsset: DEST_ASSET,
  destAddressBase58: "11111111111111111111111111111111",
  nowUnixSeconds: 1_700_000_000,
  nonce: 1n,
};

describe("buildOpenIntentParams", () => {
  it("converts a human USDC amount to Stellar's 7-decimal fixed point", () => {
    const params = buildOpenIntentParams(BASE_INPUT);
    expect(params.sourceAmount).toBe(1_000_000_000n); // 100 * 1e7
  });

  it("applies a 2% slippage tolerance to minDestAmount, in 9-decimal SPL units", () => {
    const params = buildOpenIntentParams(BASE_INPUT);
    expect(params.minDestAmount).toBe(98_000_000_000n); // 100 * 0.98 * 1e9
  });

  it("sets expiry to now + 1 hour", () => {
    const params = buildOpenIntentParams(BASE_INPUT);
    expect(params.expiry).toBe(1_700_003_600n);
  });

  it("rejects a non-numeric amount", () => {
    expect(() => buildOpenIntentParams({ ...BASE_INPUT, sourceAmountHuman: "abc" })).toThrow(
      /invalid source amount/,
    );
  });

  it("rejects a zero or negative amount", () => {
    expect(() => buildOpenIntentParams({ ...BASE_INPUT, sourceAmountHuman: "0" })).toThrow();
    expect(() => buildOpenIntentParams({ ...BASE_INPUT, sourceAmountHuman: "-5" })).toThrow();
  });

  it("carries the destAsset's assetId through as destAssetHex", () => {
    const params = buildOpenIntentParams(BASE_INPUT);
    expect(params.destAssetHex).toBe(DEST_ASSET.assetId);
  });
});
