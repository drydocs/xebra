import type { Horizon } from "@stellar/stellar-sdk";
import type { ChainEvent } from "@xebra/event-bus";
import { ChainId } from "@xebra/intent-schema";

/**
 * Decodes a classic Stellar payment (or `pathPaymentStrictReceive`) into a normalized
 * `ChainEvent` of type `"Delivery"` — this is the fulfillment leg of the *existing* Arc->Stellar
 * corridor (v1 spec "Fulfillment, Stellar side": a payment with `memo_hash` set to the intent
 * hash). Memo lives on the transaction, not the operation, in Stellar's data model — hence two
 * separate parameters rather than one combined record; apps/indexer-stellar fetches the
 * transaction via `server.transactions().transaction(payment.transaction_hash)`.
 *
 * Types verified against @stellar/stellar-sdk's real `Horizon.ServerApi.PaymentOperationRecord`
 * / `TransactionRecord` (compiled against, not guessed).
 */
export function decodeFulfillmentPayment(
  payment: Horizon.ServerApi.PaymentOperationRecord | Horizon.ServerApi.PathPaymentOperationRecord,
  transaction: Horizon.ServerApi.TransactionRecord,
): ChainEvent | null {
  if (transaction.memo_type !== "hash" || !transaction.memo) {
    return null; // not a Xebra fulfillment — no memo_hash means no intent binding
  }

  const intentHash = base64ToHex32(transaction.memo);

  return {
    id: `${ChainId.Stellar}:${payment.transaction_hash}:${payment.id}`,
    chainId: ChainId.Stellar,
    intentHash,
    eventType: "Delivery",
    txRef: payment.transaction_hash,
    blockOrLedgerNumber: null, // Horizon operation records don't carry ledger sequence directly
    observedAt: payment.created_at,
    payload: {
      from: payment.from,
      to: payment.to,
      assetType: payment.asset_type,
      assetCode: "asset_code" in payment ? payment.asset_code : undefined,
      assetIssuer: "asset_issuer" in payment ? payment.asset_issuer : undefined,
      amount: payment.amount,
    },
  };
}

function base64ToHex32(base64: string): `0x${string}` {
  const bytes = Buffer.from(base64, "base64");
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex as `0x${string}`;
}
