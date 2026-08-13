import { AssetKind, ChainId, evmErc20AssetRef, splTokenAssetRef } from "@xebra/intent-schema";
import { describe, expect, it } from "vitest";
import { type CorridorConfig, RouteError, resolveRoute } from "./route.js";
import { StaticUsdcRegistry } from "./usdc-registry.js";

// Circle's mainnet USDC mint on Solana — a real, stable constant to route against.
const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const usdcRegistry = new StaticUsdcRegistry([
  { chainId: ChainId.Solana, usdcAssetId: splTokenAssetRef(SOLANA_USDC_MINT).assetId },
]);

const STELLAR_TO_SOLANA: CorridorConfig = {
  sourceChain: ChainId.Stellar,
  destChain: ChainId.Solana,
  active: true,
  escrowAddress: "CSOROBANESCROWADDRESSPLACEHOLDER",
};

describe("resolveRoute", () => {
  it("routes a native-USDC destination through the CCTP-direct rail", () => {
    const result = resolveRoute(
      {
        sourceChain: ChainId.Stellar,
        destChain: ChainId.Solana,
        destAsset: splTokenAssetRef(SOLANA_USDC_MINT),
      },
      [STELLAR_TO_SOLANA],
      usdcRegistry,
    );
    expect(result.rail).toBe("cctp-direct");
  });

  it("routes a non-USDC destination through the intent/swap rail", () => {
    // Some other SPL mint, definitely not the registered USDC asset id.
    const otherMint = "So11111111111111111111111111111111111111112";
    const result = resolveRoute(
      {
        sourceChain: ChainId.Stellar,
        destChain: ChainId.Solana,
        destAsset: splTokenAssetRef(otherMint),
      },
      [STELLAR_TO_SOLANA],
      usdcRegistry,
    );
    expect(result.rail).toBe("intent-swap");
  });

  it("throws for an inactive or missing corridor", () => {
    expect(() =>
      resolveRoute(
        {
          sourceChain: ChainId.ArcEvm,
          destChain: ChainId.Solana,
          destAsset: splTokenAssetRef(SOLANA_USDC_MINT),
        },
        [STELLAR_TO_SOLANA],
        usdcRegistry,
      ),
    ).toThrow(RouteError);
  });

  it("throws when a non-USDC swap is requested on a CCTP-only corridor (no escrow)", () => {
    const cctpOnly: CorridorConfig = {
      sourceChain: ChainId.Stellar,
      destChain: ChainId.Solana,
      active: true,
      // no escrowAddress
    };
    const otherMint = "So11111111111111111111111111111111111111112";
    expect(() =>
      resolveRoute(
        {
          sourceChain: ChainId.Stellar,
          destChain: ChainId.Solana,
          destAsset: splTokenAssetRef(otherMint),
        },
        [cctpOnly],
        usdcRegistry,
      ),
    ).toThrow(RouteError);
  });

  it("does not treat an EVM asset with a matching-looking id as Solana USDC", () => {
    // Same chainId as registered? No — different chain entirely, must not match.
    const arcAsset = evmErc20AssetRef(`0x${"aa".repeat(20)}`);
    const result = resolveRoute(
      { sourceChain: ChainId.Stellar, destChain: ChainId.Solana, destAsset: arcAsset },
      [STELLAR_TO_SOLANA],
      usdcRegistry,
    );
    // Wrong-chain asset can never satisfy isNativeUsdc for Solana, so it falls to intent-swap.
    expect(result.rail).toBe("intent-swap");
    expect(arcAsset.kind).toBe(AssetKind.EvmErc20);
  });
});
