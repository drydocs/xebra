import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { decodeSorobanEvents } from "./decode-soroban-events.js";

function makeEvent(opts: {
  topicName: string;
  data: Record<string, unknown>;
  id?: string;
  txHash?: string;
  ledger?: number;
}): rpc.Api.EventResponse {
  const topic = [nativeToScVal(opts.topicName, { type: "symbol" })];
  const value = nativeToScVal(opts.data, { type: "instance" });

  return {
    id: opts.id ?? "0000000001-0000000001",
    type: "contract",
    ledger: opts.ledger ?? 100,
    ledgerClosedAt: "2026-01-01T00:00:00Z",
    pagingToken: "1",
    inSuccessfulContractCall: true,
    txHash: opts.txHash ?? "abc123",
    topic,
    value,
  } as rpc.Api.EventResponse;
}

describe("decodeSorobanEvents", () => {
  // Topic names are snake_case ("intent_opened", not "IntentOpened") — confirmed against real
  // events emitted by a live testnet deployment in scripts/e2e-demo (see this file's module doc
  // comment); PascalCase here would silently match nothing, as it originally did.
  it("decodes a recognized event topic into a ChainEvent", () => {
    const events = decodeSorobanEvents([
      makeEvent({
        topicName: "intent_opened",
        data: { intent_hash: "deadbeef", source_amount: 100n },
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("IntentOpened");
    expect(events[0]?.intentHash).toBe("deadbeef");
    expect(events[0]?.payload.source_amount).toBe("100"); // bigint serialized to string
  });

  it("skips events whose topic isn't a recognized Xebra event", () => {
    const events = decodeSorobanEvents([
      makeEvent({ topicName: "some_other_contract_event", data: {} }),
    ]);
    expect(events).toHaveLength(0);
  });

  it("returns a null intentHash when the event data has no recognizable key", () => {
    const events = decodeSorobanEvents([
      makeEvent({ topicName: "intent_finalized", data: { solver: "GABC" } }),
    ]);
    expect(events[0]?.intentHash).toBeNull();
  });

  it("decodes the CCTP wrapper's bridge_initiated into a CctpBurn", () => {
    const events = decodeSorobanEvents([
      makeEvent({
        topicName: "bridge_initiated",
        data: {
          transfer_id: "cafebabe",
          seq: 1n,
          amount: 1_000_0000000n,
          fee: 1_0000000n,
          net_burned: 999_0000000n,
          remainder: 0n,
          destination_domain: 5,
        },
      }),
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]?.eventType).toBe("CctpBurn");
    // A plain CCTP transfer is not tied to an intent — `ChainEvent.intentHash` is nullable
    // precisely for this case, so `transfer_id` must NOT be coerced into it.
    expect(events[0]?.intentHash).toBeNull();
    expect(events[0]?.payload.transfer_id).toBe("cafebabe");
    // 999 USDC in 7-decimal stroops, serialized from bigint to string.
    expect(events[0]?.payload.net_burned).toBe("9990000000");
  });

  it("ignores the wrapper's operational events", () => {
    // These are alerting signals about our own contract, not corridor facts; projecting them
    // into escrow_events would be wrong.
    const events = decodeSorobanEvents([
      makeEvent({ topicName: "params_proposed", data: { eta: 1n } }),
      makeEvent({ topicName: "fee_recipient_proposed", data: { eta: 1n } }),
    ]);
    expect(events).toHaveLength(0);
  });

  it("builds a dedup id from chainId, txHash, and event id", () => {
    const events = decodeSorobanEvents([
      makeEvent({ topicName: "intent_claimed", data: {}, txHash: "tx1", id: "evt1" }),
    ]);
    expect(events[0]?.id).toBe("2:tx1:evt1");
  });
});
