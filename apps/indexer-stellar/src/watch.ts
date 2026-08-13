import type { Horizon, rpc } from "@stellar/stellar-sdk";
import { decodeFulfillmentPayment, decodeSorobanEvents } from "@xebra/chain-adapters";
import type { EventProducer } from "@xebra/event-bus";
import type { Logger } from "pino";

/**
 * apps/indexer-stellar — watches two independent sources, since Stellar is both a destination
 * (existing Arc->Stellar corridor, v1 spec) and a source (new Stellar->Solana corridor, this
 * build) in the hub design (docs/architecture.md):
 *
 * 1. Soroban RPC `getEvents` on the new Stellar-source XebraEscrow contract.
 * 2. Horizon payments to known fulfillment addresses, for the *existing* Arc->Stellar corridor
 *    (solvers pay `destAddress` directly there — no escrow contract to subscribe to).
 *
 * Both poll functions are cursor-based and testable via injected sources; index.ts wires the
 * real `rpc.Server`/`Horizon.Server` clients.
 */

export interface SorobanEventSource {
  getEvents(cursor: string | undefined, contractId: string): Promise<rpc.Api.GetEventsResponse>;
}

export async function pollSorobanEventsOnce(
  source: SorobanEventSource,
  contractId: string,
  cursor: string | undefined,
  producer: EventProducer,
  logger: Logger,
): Promise<string | undefined> {
  const response = await source.getEvents(cursor, contractId);
  const events = decodeSorobanEvents(response.events);

  for (const event of events) {
    await producer.publish(event);
    logger.info(
      { eventType: event.eventType, intentHash: event.intentHash },
      "indexer-stellar: published soroban event",
    );
  }

  // `||`, not `??`: an empty-string cursor is treated the same as a missing one, so a
  // response with no pagination progress doesn't reset the caller back to undefined.
  return response.cursor || cursor;
}

export interface HorizonPaymentSource {
  getPayments(
    address: string,
    cursor: string | undefined,
  ): Promise<{
    records: Horizon.ServerApi.PaymentOperationRecord[];
    nextCursor: string | undefined;
  }>;
  getTransaction(hash: string): Promise<Horizon.ServerApi.TransactionRecord>;
}

export async function pollFulfillmentPaymentsOnce(
  source: HorizonPaymentSource,
  address: string,
  cursor: string | undefined,
  producer: EventProducer,
  logger: Logger,
): Promise<string | undefined> {
  const { records, nextCursor } = await source.getPayments(address, cursor);

  for (const payment of records) {
    const transaction = await source.getTransaction(payment.transaction_hash);
    const event = decodeFulfillmentPayment(payment, transaction);
    if (event) {
      await producer.publish(event);
      logger.info(
        { intentHash: event.intentHash, txRef: event.txRef },
        "indexer-stellar: published fulfillment payment",
      );
    }
  }

  return nextCursor ?? cursor;
}
