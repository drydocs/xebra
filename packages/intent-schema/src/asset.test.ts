import { describe, expect, it } from "vitest";
import {
  assetRefToEvmAddress,
  assetRefToSplMint,
  evmErc20AssetRef,
  nativeSolAssetRef,
  nativeXlmAssetRef,
  splTokenAssetRef,
  stellarClassicAssetRef,
  stellarClassicAssetRefFromRaw,
} from "./asset.js";
import { ZERO_HEX32 } from "./hex.js";
import { AssetKind, ChainId } from "./types.js";

describe("stellar classic asset ref", () => {
  it("hashes assetCode||issuer deterministically", () => {
    const issuer = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
    const a = stellarClassicAssetRef("USDC", issuer);
    const b = stellarClassicAssetRef("USDC", issuer);
    expect(a.assetId).toBe(b.assetId);
    expect(a.assetId).not.toBe(ZERO_HEX32);
    expect(a.kind).toBe(AssetKind.StellarClassicAsset);
  });

  it("differs for a different asset code or issuer", () => {
    const issuer = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
    const usdc = stellarClassicAssetRef("USDC", issuer);
    const eurc = stellarClassicAssetRef("EURC", issuer);
    expect(usdc.assetId).not.toBe(eurc.assetId);
  });

  it("native XLM is the zero hash", () => {
    expect(nativeXlmAssetRef().assetId).toBe(ZERO_HEX32);
    expect(nativeXlmAssetRef().kind).toBe(AssetKind.Native);
  });

  it("stellarClassicAssetRefFromRaw recognizes the zero hash as native", () => {
    expect(stellarClassicAssetRefFromRaw(ZERO_HEX32).kind).toBe(AssetKind.Native);
    const nonZero = stellarClassicAssetRef(
      "USDC",
      "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
    );
    expect(stellarClassicAssetRefFromRaw(nonZero.assetId).kind).toBe(AssetKind.StellarClassicAsset);
  });
});

describe("SPL token asset ref", () => {
  it("uses the raw mint pubkey directly (no hashing) and round-trips", () => {
    // Circle's mainnet USDC mint on Solana.
    const mint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
    const ref = splTokenAssetRef(mint);
    expect(ref.chainId).toBe(ChainId.Solana);
    expect(ref.kind).toBe(AssetKind.SplToken);
    expect(assetRefToSplMint(ref)).toBe(mint);
  });

  it("native SOL is the zero hash", () => {
    expect(nativeSolAssetRef().assetId).toBe(ZERO_HEX32);
  });
});

describe("EVM ERC-20 asset ref", () => {
  it("left-pads the 20-byte contract address and round-trips", () => {
    const contract = `0x${"71".repeat(20)}`;
    const ref = evmErc20AssetRef(contract);
    expect(ref.chainId).toBe(ChainId.ArcEvm);
    expect(assetRefToEvmAddress(ref)).toBe(contract);
  });
});
