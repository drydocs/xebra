import { nativeToScVal, xdr } from "@stellar/stellar-sdk";
import type { rpc } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { createSorobanBurnSource, toBurnEvents } from "./soroban-burn-source.js";

function event(topic: string, txHash: string): rpc.Api.EventResponse {
  return {
    topic: [nativeToScVal(topic, { type: "symbol" })],
    value: nativeToScVal(0),
    txHash,
  } as unknown as rpc.Api.EventResponse;
}

describe("toBurnEvents", () => {
  it("keeps bridge_initiated and drops the wrapper's other events", () => {
    // The wrapper emits operational events too. Queueing a mint for `params_proposed` would
    // poll Iris for a message that does not exist until the job dead-letters.
    const events = [
      event("bridge_initiated", "aaa"),
      event("params_proposed", "bbb"),
      event("fee_recipient_proposed", "ccc"),
      event("bridge_initiated", "ddd"),
    ];
    expect(toBurnEvents(events).map((e) => e.txHash)).toEqual(["aaa", "ddd"]);
  });

  it("does not match a PascalCase topic", () => {
    // Soroban's #[contractevent] topics are snake_case. This repo shipped a live bug from
    // assuming otherwise, so the wrong casing must stay a miss rather than quietly work.
    expect(toBurnEvents([event("BridgeInitiated", "aaa")])).toEqual([]);
  });

  it("skips an event whose topic will not decode instead of failing the batch", () => {
    const undecodable = {
      topic: [xdr.ScVal.scvLedgerKeyContractInstance()],
      value: nativeToScVal(0),
      txHash: "bad",
    } as unknown as rpc.Api.EventResponse;

    // The good event behind the bad one must still be queued — a poison event in a page
    // would otherwise stall every burn after it, permanently.
    expect(toBurnEvents([undecodable, event("bridge_initiated", "aaa")])).toEqual([
      { txHash: "aaa" },
    ]);
  });

  it("takes only the transaction hash", () => {
    // Amounts and recipients come from Circle's signed attestation, never from an RPC
    // response the relay cannot verify.
    expect(toBurnEvents([event("bridge_initiated", "aaa")])).toEqual([{ txHash: "aaa" }]);
  });
});

describe("createSorobanBurnSource", () => {
  it("passes the cursor through and returns the RPC's next cursor", async () => {
    let seen: string | undefined = "unset";
    const read = createSorobanBurnSource({
      async getEvents(cursor) {
        seen = cursor;
        return {
          events: [event("bridge_initiated", "aaa")],
          cursor: "next-1",
        } as unknown as rpc.Api.GetEventsResponse;
      },
    });

    const result = await read("cursor-0");
    expect(seen).toBe("cursor-0");
    expect(result).toEqual({ events: [{ txHash: "aaa" }], nextCursor: "next-1" });
  });
});
