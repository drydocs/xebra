import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
  AddrEncoding,
  AssetKind,
  ChainId,
  type IntentV2,
  splTokenAssetRef,
} from "@xebra/intent-schema";
import { describe, expect, it, vi } from "vitest";
import { type InventoryChecker, createSolanaFillAdapter } from "./solana-fill.js";

const MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

const SOLANA_INTENT: IntentV2 = {
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
  destAsset: splTokenAssetRef(MINT),
  minDestAmount: 900_000_000n,
  destAddress: {
    chainId: ChainId.Solana,
    encoding: AddrEncoding.SolanaEd25519_32,
    raw: `0x${"3".repeat(64)}`,
  },
  expiry: 2_000_000_000n,
  nonce: 1n,
};

// quote() is the only part of this adapter testable without a live Solana connection — fill()
// signs and submits a real transaction (sendAndConfirmTransaction), which is real, compiled
// code but not exercised live in this test suite (no Solana validator available; see
// docs/architecture.md and this adapter's module doc comment).
describe("createSolanaFillAdapter (quote)", () => {
  it("can fill when inventory covers minDestAmount", async () => {
    const inventory: InventoryChecker = { getBalance: vi.fn(async () => 1_000_000_000n) };
    const adapter = createSolanaFillAdapter(
      new Connection("http://localhost:8899"),
      Keypair.generate(),
      inventory,
    );

    const quote = await adapter.quote(SOLANA_INTENT);

    expect(quote).toEqual({ canFill: true, deliveredAmount: 900_000_000n });
    expect(inventory.getBalance).toHaveBeenCalledWith(new PublicKey(MINT));
  });

  it("cannot fill when inventory is short", async () => {
    const inventory: InventoryChecker = { getBalance: vi.fn(async () => 100n) };
    const adapter = createSolanaFillAdapter(
      new Connection("http://localhost:8899"),
      Keypair.generate(),
      inventory,
    );

    const quote = await adapter.quote(SOLANA_INTENT);

    expect(quote.canFill).toBe(false);
    expect(quote.reason).toMatch(/insufficient inventory/);
  });

  it("refuses to quote an intent whose destChain isn't Solana", async () => {
    const inventory: InventoryChecker = { getBalance: vi.fn() };
    const adapter = createSolanaFillAdapter(
      new Connection("http://localhost:8899"),
      Keypair.generate(),
      inventory,
    );

    const quote = await adapter.quote({ ...SOLANA_INTENT, destChain: ChainId.Stellar });

    expect(quote.canFill).toBe(false);
    expect(inventory.getBalance).not.toHaveBeenCalled();
  });
});
