import type { ConfirmedSignatureInfo, ParsedTransactionWithMeta } from "@solana/web3.js";
import { parseDeliveryTx } from "@xebra/chain-adapters";
import type { EventProducer } from "@xebra/event-bus";
import type { ChainEvent } from "@xebra/event-bus";
import { ChainId } from "@xebra/intent-schema";
import type { Logger } from "pino";

/**
 * apps/indexer-solana — watches known solver wallets for delivery transactions (memo + SPL
 * transfer, see @xebra/chain-adapters' parseDeliveryTx and docs/architecture.md §4) and
 * publishes normalized "Delivery" ChainEvents. Solana has no escrow contract to subscribe to
 * in v1 (destination-only) — this is why the watch model here polls specific addresses'
 * signatures rather than subscribing to a contract the way indexer-arc/-stellar do.
 *
 * `toChainEvent` is the one piece worth unit-testing on its own; the polling loop itself is
 * thin live wiring around @solana/web3.js's Connection.
 */

export function toChainEvent(
  signature: ConfirmedSignatureInfo,
  tx: ParsedTransactionWithMeta,
): ChainEvent | null {
  const parsed = parseDeliveryTx(tx);
  // Not every transaction a solver wallet sends is a Xebra delivery (rebalancing, gas top-ups,
  // etc.) — no memo means it isn't one, and there's nothing worth publishing.
  if (!parsed.intentHashHex) return null;

  return {
    id: `${ChainId.Solana}:${signature.signature}:0`,
    chainId: ChainId.Solana,
    intentHash: parsed.intentHashHex,
    eventType: "Delivery",
    txRef: signature.signature,
    blockOrLedgerNumber: signature.slot != null ? signature.slot.toString() : null,
    observedAt: new Date().toISOString(),
    payload: {
      mint: parsed.mint,
      amount: parsed.amount != null ? parsed.amount.toString() : null,
      recipientTokenAccount: parsed.recipientTokenAccount,
    },
  };
}

export interface SolanaTxSource {
  getSignaturesForAddress(
    address: string,
    opts: { until?: string },
  ): Promise<ConfirmedSignatureInfo[]>;
  getParsedTransaction(signature: string): Promise<ParsedTransactionWithMeta | null>;
}

export async function pollOnce(
  source: SolanaTxSource,
  solverAddress: string,
  lastSeenSignature: string | undefined,
  producer: EventProducer,
  logger: Logger,
): Promise<string | undefined> {
  const signatures = await source.getSignaturesForAddress(
    solverAddress,
    lastSeenSignature ? { until: lastSeenSignature } : {},
  );

  // getSignaturesForAddress returns newest-first; process oldest-first so `lastSeenSignature`
  // only ever advances past transactions we've actually published.
  for (const sig of [...signatures].reverse()) {
    const tx = await source.getParsedTransaction(sig.signature);
    if (!tx) continue;

    const event = toChainEvent(sig, tx);
    if (event) {
      await producer.publish(event);
      logger.info(
        { signature: sig.signature, intentHash: event.intentHash },
        "indexer-solana: published delivery",
      );
    }
  }

  return signatures[0]?.signature ?? lastSeenSignature;
}
