import type { ChainEvent } from "@xebra/event-bus";
import { ChainId } from "@xebra/intent-schema";
import { describe, expect, it } from "vitest";
import { intentFromChainEvent } from "./decode-intent-event.js";

function baseEvent(overrides: Partial<ChainEvent> = {}): ChainEvent {
  return {
    id: "2:tx1:0",
    chainId: ChainId.Stellar,
    intentHash: `0x${"aa".repeat(32)}`,
    eventType: "IntentOpened",
    txRef: "tx1",
    blockOrLedgerNumber: "100",
    observedAt: new Date().toISOString(),
    payload: {
      user: `0x${"11".repeat(32)}`,
      dest_chain: ChainId.Solana,
      dest_asset: `0x${"22".repeat(32)}`,
      min_dest_amount: "900000000",
      dest_address: `0x${"33".repeat(32)}`,
      source_amount: "1000000000",
      expiry: "2000000000",
      nonce: "1",
    },
    ...overrides,
  };
}

describe("intentFromChainEvent", () => {
  it("reconstructs an IntentV2 from a well-formed IntentOpened payload", () => {
    const intent = intentFromChainEvent(baseEvent());
    expect(intent).not.toBeNull();
    expect(intent?.sourceChain).toBe(ChainId.Stellar);
    expect(intent?.destChain).toBe(ChainId.Solana);
    expect(intent?.sourceAmount).toBe(1_000_000_000n);
    expect(intent?.minDestAmount).toBe(900_000_000n);
    expect(intent?.nonce).toBe(1n);
  });

  it("returns null for a non-IntentOpened event", () => {
    expect(intentFromChainEvent(baseEvent({ eventType: "IntentClaimed" }))).toBeNull();
  });

  it("returns null for an event from a chain other than Stellar", () => {
    expect(intentFromChainEvent(baseEvent({ chainId: ChainId.Solana }))).toBeNull();
  });

  it("returns null for an event with no intentHash", () => {
    expect(intentFromChainEvent(baseEvent({ intentHash: null }))).toBeNull();
  });

  it("returns null when the payload is missing expected fields (defensive, doesn't throw)", () => {
    expect(intentFromChainEvent(baseEvent({ payload: { user: "0x1" } }))).toBeNull();
  });
});
