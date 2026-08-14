import type { ChainEvent } from "@xebra/event-bus";
import { ChainId } from "@xebra/intent-schema";
import { describe, expect, it } from "vitest";
import { corridorId } from "./corridor-id.js";
import { projectIntentOpened } from "./project-intent-opened.js";

function arcEvent(overrides: Partial<ChainEvent> = {}): ChainEvent {
  return {
    id: "1:tx1:0",
    chainId: ChainId.ArcEvm,
    intentHash: `0x${"aa".repeat(32)}`,
    eventType: "IntentOpened",
    txRef: "tx1",
    blockOrLedgerNumber: "100",
    observedAt: new Date().toISOString(),
    payload: {
      user: `0x${"11".repeat(20)}`,
      sourceToken: `0x${"22".repeat(20)}`,
      sourceAmount: "100000000",
      destAsset: `0x${"0".repeat(64)}`,
      minDestAmount: "9000000000",
      destAddress: `0x${"33".repeat(32)}`,
      expiry: "2000000000",
      nonce: "1",
    },
    ...overrides,
  };
}

function sorobanEvent(overrides: Partial<ChainEvent> = {}): ChainEvent {
  return {
    id: "2:tx1:0",
    chainId: ChainId.Stellar,
    intentHash: `0x${"bb".repeat(32)}`,
    eventType: "IntentOpened",
    txRef: "tx1",
    blockOrLedgerNumber: "200",
    observedAt: new Date().toISOString(),
    payload: {
      user: `0x${"44".repeat(32)}`,
      source_token: `0x${"0".repeat(64)}`,
      source_amount: "1000000000",
      dest_chain: ChainId.Solana,
      dest_asset: `0x${"55".repeat(32)}`,
      min_dest_amount: "900000000",
      dest_address: `0x${"66".repeat(32)}`,
      expiry: "2000000000",
      nonce: "1",
    },
    ...overrides,
  };
}

describe("projectIntentOpened", () => {
  it("maps an Arc IntentOpened event using the arc->stellar corridor", () => {
    const row = projectIntentOpened(arcEvent());
    expect(row).not.toBeNull();
    expect(row?.corridorId).toBe(corridorId(ChainId.ArcEvm, ChainId.Stellar));
    expect(row?.sourceAmount).toBe("100000000");
    expect(row?.status).toBe("open");
  });

  it("maps a Soroban IntentOpened event using the stellar->solana corridor", () => {
    const row = projectIntentOpened(sorobanEvent());
    expect(row).not.toBeNull();
    expect(row?.corridorId).toBe(corridorId(ChainId.Stellar, ChainId.Solana));
    expect(row?.sourceAmount).toBe("1000000000");
  });

  it("returns null for a non-IntentOpened event", () => {
    expect(projectIntentOpened(arcEvent({ eventType: "IntentClaimed" }))).toBeNull();
  });

  it("returns null for an event from an unrecognized source chain", () => {
    expect(projectIntentOpened(arcEvent({ chainId: ChainId.Solana }))).toBeNull();
  });

  it("returns null for a malformed Arc payload (defensive, doesn't throw)", () => {
    expect(projectIntentOpened(arcEvent({ payload: { user: "0x1" } }))).toBeNull();
  });

  it("returns null for a malformed Soroban payload (defensive, doesn't throw)", () => {
    expect(projectIntentOpened(sorobanEvent({ payload: { user: "0x1" } }))).toBeNull();
  });
});
