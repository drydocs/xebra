import { ChainId, splTokenAssetRef } from "@xebra/intent-schema";
import { describe, expect, it } from "vitest";
import type { CorridorRow } from "./quote.js";
import { resolveQuote } from "./quote.js";

const SOLANA_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_ROWS = [
  { chainId: ChainId.Solana, assetId: splTokenAssetRef(SOLANA_USDC_MINT).assetId },
];
const CORRIDOR_ROWS: CorridorRow[] = [
  {
    id: "stellar->solana",
    sourceChainId: ChainId.Stellar,
    destChainId: ChainId.Solana,
    escrowContractAddress: "CSOROBANESCROW",
    active: true,
  },
];

describe("resolveQuote", () => {
  it("routes native USDC through the CCTP-direct rail", () => {
    const result = resolveQuote(
      {
        sourceChain: ChainId.Stellar,
        destChain: ChainId.Solana,
        destAsset: splTokenAssetRef(SOLANA_USDC_MINT),
      },
      CORRIDOR_ROWS,
      USDC_ROWS,
    );
    expect(result.rail).toBe("cctp-direct");
  });

  it("routes a non-USDC asset through the intent/swap rail", () => {
    const otherMint = "So11111111111111111111111111111111111111112";
    const result = resolveQuote(
      {
        sourceChain: ChainId.Stellar,
        destChain: ChainId.Solana,
        destAsset: splTokenAssetRef(otherMint),
      },
      CORRIDOR_ROWS,
      USDC_ROWS,
    );
    expect(result.rail).toBe("intent-swap");
  });

  it("throws for a corridor with no rows in the DB yet", () => {
    expect(() =>
      resolveQuote(
        {
          sourceChain: ChainId.ArcEvm,
          destChain: ChainId.Solana,
          destAsset: splTokenAssetRef(SOLANA_USDC_MINT),
        },
        CORRIDOR_ROWS,
        USDC_ROWS,
      ),
    ).toThrow();
  });

  it("treats a corridor row with a null escrow address as CCTP-only", () => {
    const cctpOnlyRow: CorridorRow[] = [
      { ...CORRIDOR_ROWS[0], escrowContractAddress: null } as CorridorRow,
    ];
    const otherMint = "So11111111111111111111111111111111111111112";
    expect(() =>
      resolveQuote(
        {
          sourceChain: ChainId.Stellar,
          destChain: ChainId.Solana,
          destAsset: splTokenAssetRef(otherMint),
        },
        cctpOnlyRow,
        USDC_ROWS,
      ),
    ).toThrow(/no intent\/swap escrow/);
  });
});
