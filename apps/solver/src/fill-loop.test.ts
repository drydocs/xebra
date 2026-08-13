import { AddrEncoding, AssetKind, ChainId, type IntentV2 } from "@xebra/intent-schema";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { ClaimAdapter, FillAdapter } from "./fill-loop.js";
import { processOpenedIntent } from "./fill-loop.js";

const LOGGER = pino({ enabled: false });

const INTENT: IntentV2 = {
  version: 2,
  user: {
    chainId: ChainId.Stellar,
    encoding: AddrEncoding.StellarEd25519_32,
    raw: `0x${"1".repeat(64)}`,
  },
  sourceChain: ChainId.Stellar,
  sourceAsset: { chainId: ChainId.Stellar, kind: AssetKind.Native, assetId: `0x${"0".repeat(64)}` },
  sourceAmount: 100_0000000n,
  destChain: ChainId.Solana,
  destAsset: { chainId: ChainId.Solana, kind: AssetKind.SplToken, assetId: `0x${"2".repeat(64)}` },
  minDestAmount: 900_000_000n,
  destAddress: {
    chainId: ChainId.Solana,
    encoding: AddrEncoding.SolanaEd25519_32,
    raw: `0x${"3".repeat(64)}`,
  },
  expiry: 2_000_000_000n,
  nonce: 1n,
};

describe("processOpenedIntent", () => {
  it("skips an intent the fill adapter judges unprofitable, without calling fill or claim", async () => {
    const fill: FillAdapter = {
      quote: vi.fn(async () => ({
        canFill: false,
        deliveredAmount: 0n,
        reason: "insufficient inventory",
      })),
      fill: vi.fn(),
    };
    const claim: ClaimAdapter = { claim: vi.fn() };

    const outcome = await processOpenedIntent("0xhash", INTENT, { fill, claim, logger: LOGGER });

    expect(outcome).toEqual({ status: "skipped", reason: "insufficient inventory" });
    expect(fill.fill).not.toHaveBeenCalled();
    expect(claim.claim).not.toHaveBeenCalled();
  });

  it("fills and claims a profitable intent, returning both tx refs", async () => {
    const fill: FillAdapter = {
      quote: vi.fn(async () => ({ canFill: true, deliveredAmount: 950_000_000n })),
      fill: vi.fn(async () => ({ destTxRef: "solana-sig-1", deliveredAmount: 950_000_000n })),
    };
    const claim: ClaimAdapter = {
      claim: vi.fn(async () => ({ claimTxRef: "soroban-tx-1" })),
    };

    const outcome = await processOpenedIntent("0xhash", INTENT, { fill, claim, logger: LOGGER });

    expect(outcome).toEqual({
      status: "filled",
      destTxRef: "solana-sig-1",
      claimTxRef: "soroban-tx-1",
      deliveredAmount: 950_000_000n,
    });
    expect(fill.fill).toHaveBeenCalledWith(INTENT, "0xhash");
    expect(claim.claim).toHaveBeenCalledWith("0xhash", {
      destTxRef: "solana-sig-1",
      deliveredAmount: 950_000_000n,
    });
  });

  it("reports a fill-stage failure without ever attempting to claim", async () => {
    const fill: FillAdapter = {
      quote: vi.fn(async () => ({ canFill: true, deliveredAmount: 950_000_000n })),
      fill: vi.fn(async () => {
        throw new Error("thin liquidity, path payment would fail");
      }),
    };
    const claim: ClaimAdapter = { claim: vi.fn() };

    const outcome = await processOpenedIntent("0xhash", INTENT, { fill, claim, logger: LOGGER });

    expect(outcome).toEqual({
      status: "failed",
      stage: "fill",
      error: "thin liquidity, path payment would fail",
    });
    expect(claim.claim).not.toHaveBeenCalled();
  });

  it("reports a claim-stage failure separately from a fill-stage one (delivery already happened)", async () => {
    const fill: FillAdapter = {
      quote: vi.fn(async () => ({ canFill: true, deliveredAmount: 950_000_000n })),
      fill: vi.fn(async () => ({ destTxRef: "solana-sig-1", deliveredAmount: 950_000_000n })),
    };
    const claim: ClaimAdapter = {
      claim: vi.fn(async () => {
        throw new Error("insufficient bond balance");
      }),
    };

    const outcome = await processOpenedIntent("0xhash", INTENT, { fill, claim, logger: LOGGER });

    expect(outcome).toEqual({
      status: "failed",
      stage: "claim",
      error: "insufficient bond balance",
    });
  });
});
