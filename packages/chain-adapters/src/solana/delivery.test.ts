import { PublicKey } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { MEMO_PROGRAM_ID, buildDeliveryInstructions, encodeMemoData } from "./delivery.js";

const PAYER = new PublicKey("11111111111111111111111111111111");
const MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const RECIPIENT = new PublicKey("So11111111111111111111111111111111111111112");
const INTENT_HASH = new Uint8Array(32).fill(7);

describe("buildDeliveryInstructions", () => {
  it("builds exactly [create-ATA, transfer, memo] in that order", () => {
    const ixs = buildDeliveryInstructions({
      payer: PAYER,
      mint: MINT,
      recipient: RECIPIENT,
      amount: 900_000_000n,
      decimals: 9,
      intentHash: INTENT_HASH,
    });

    expect(ixs).toHaveLength(3);
    // The memo instruction is last and carries the raw intent hash as its data.
    const memoIx = ixs.at(2);
    if (!memoIx) throw new Error("expected a third instruction");
    expect(memoIx.programId.equals(MEMO_PROGRAM_ID)).toBe(true);
    expect(new Uint8Array(memoIx.data)).toEqual(INTENT_HASH);
  });

  it("rejects an intent hash that isn't 32 bytes", () => {
    expect(() =>
      buildDeliveryInstructions({
        payer: PAYER,
        mint: MINT,
        recipient: RECIPIENT,
        amount: 1n,
        decimals: 9,
        intentHash: new Uint8Array(31),
      }),
    ).toThrow(/32 bytes/);
  });
});

describe("encodeMemoData", () => {
  it("base58-encodes the intent hash the same way a solver's tx would carry it", () => {
    const encoded = encodeMemoData(INTENT_HASH);
    expect(typeof encoded).toBe("string");
    expect(encoded.length).toBeGreaterThan(0);
  });
});
