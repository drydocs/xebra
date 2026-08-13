import type { Horizon } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import { decodeFulfillmentPayment } from "./decode-horizon-payment.js";

function paymentFixture(): Horizon.ServerApi.PaymentOperationRecord {
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

function transactionFixture(overrides: Partial<Horizon.ServerApi.TransactionRecord> = {}) {
  return {
    memo_type: "hash",
    memo: Buffer.alloc(32, 7).toString("base64"),
    ...overrides,
  } as unknown as Horizon.ServerApi.TransactionRecord;
}

describe("decodeFulfillmentPayment", () => {
  it("decodes a payment with memo_hash into a Delivery ChainEvent", () => {
    const event = decodeFulfillmentPayment(paymentFixture(), transactionFixture());
    expect(event?.eventType).toBe("Delivery");
    expect(event?.intentHash).toBe(`0x${"07".repeat(32)}`);
    expect(event?.txRef).toBe("tx1");
    expect(event?.payload.to).toBe("GTO");
  });

  it("returns null when the transaction has no memo_hash (not a Xebra fulfillment)", () => {
    const noMemoTx = { memo_type: "none" } as unknown as Horizon.ServerApi.TransactionRecord;
    expect(decodeFulfillmentPayment(paymentFixture(), noMemoTx)).toBeNull();
  });

  it("returns null when the memo is a text memo, not a hash memo", () => {
    expect(
      decodeFulfillmentPayment(
        paymentFixture(),
        transactionFixture({ memo_type: "text", memo: "hello" }),
      ),
    ).toBeNull();
  });
});
