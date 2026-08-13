import { nativeToScVal } from "@stellar/stellar-sdk";
import type { Horizon, rpc } from "@stellar/stellar-sdk";
import type { EventProducer } from "@xebra/event-bus";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { HorizonPaymentSource, SorobanEventSource } from "./watch.js";
import { pollFulfillmentPaymentsOnce, pollSorobanEventsOnce } from "./watch.js";

const LOGGER = pino({ enabled: false });

describe("pollSorobanEventsOnce", () => {
  it("publishes decoded events and advances the cursor", async () => {
    const event = {
      id: "evt1",
      type: "contract",
      ledger: 100,
      ledgerClosedAt: "2026-01-01T00:00:00Z",
      pagingToken: "1",
      inSuccessfulContractCall: true,
      txHash: "tx1",
      topic: [nativeToScVal("IntentOpened", { type: "symbol" })],
      value: nativeToScVal({ intent_hash: "deadbeef" }, { type: "instance" }),
    } as unknown as rpc.Api.EventResponse;

    const source: SorobanEventSource = {
      getEvents: vi.fn(async () => ({ latestLedger: 101, events: [event], cursor: "newcursor" })),
    };
    const producer: EventProducer = { publish: vi.fn(), disconnect: vi.fn() };

    const cursor = await pollSorobanEventsOnce(source, "CCONTRACT", undefined, producer, LOGGER);

    expect(producer.publish).toHaveBeenCalledTimes(1);
    expect(cursor).toBe("newcursor");
  });

  it("keeps the old cursor if the response has none", async () => {
    const source: SorobanEventSource = {
      getEvents: vi.fn(async () => ({ latestLedger: 101, events: [], cursor: "" })),
    };
    const producer: EventProducer = { publish: vi.fn(), disconnect: vi.fn() };

    const cursor = await pollSorobanEventsOnce(source, "CCONTRACT", "oldcursor", producer, LOGGER);
    expect(cursor).toBe("oldcursor");
  });
});

describe("pollFulfillmentPaymentsOnce", () => {
  function paymentRecord(): Horizon.ServerApi.PaymentOperationRecord {
    return {
      id: "op1",
      transaction_hash: "tx1",
      created_at: "2026-01-01T00:00:00Z",
      from: "GFROM",
      to: "GTO",
      asset_type: "native",
      amount: "900.0000000",
    } as unknown as Horizon.ServerApi.PaymentOperationRecord;
  }

  function txWithMemo(): Horizon.ServerApi.TransactionRecord {
    return {
      memo_type: "hash",
      memo: Buffer.alloc(32, 7).toString("base64"),
    } as unknown as Horizon.ServerApi.TransactionRecord;
  }

  it("publishes a Delivery event for a payment with memo_hash", async () => {
    const source: HorizonPaymentSource = {
      getPayments: vi.fn(async () => ({ records: [paymentRecord()], nextCursor: "cursor2" })),
      getTransaction: vi.fn(async () => txWithMemo()),
    };
    const producer: EventProducer = { publish: vi.fn(), disconnect: vi.fn() };

    const cursor = await pollFulfillmentPaymentsOnce(source, "GDEST", undefined, producer, LOGGER);

    expect(producer.publish).toHaveBeenCalledTimes(1);
    expect(cursor).toBe("cursor2");
  });

  it("doesn't publish for a payment whose transaction has no memo_hash", async () => {
    const source: HorizonPaymentSource = {
      getPayments: vi.fn(async () => ({ records: [paymentRecord()], nextCursor: "cursor2" })),
      getTransaction: vi.fn(
        async () => ({ memo_type: "none" }) as unknown as Horizon.ServerApi.TransactionRecord,
      ),
    };
    const producer: EventProducer = { publish: vi.fn(), disconnect: vi.fn() };

    await pollFulfillmentPaymentsOnce(source, "GDEST", undefined, producer, LOGGER);

    expect(producer.publish).not.toHaveBeenCalled();
  });
});
