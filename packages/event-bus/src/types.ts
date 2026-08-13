/**
 * @xebra/event-bus — the Redpanda/Kafka event backbone (docs/architecture.md §8): chain
 * watchers (apps/indexer-*) publish normalized `ChainEvent`s here; apps/api's DB-projection
 * consumer, apps/solver, and apps/cctp-relay all subscribe independently. This is the "what
 * happened" tier — durable, replayable facts — distinct from BullMQ's "do this" job-queue tier
 * used inside apps/cctp-relay.
 */

export const CHAIN_EVENTS_TOPIC = "xebra.chain-events";

export type ChainEventType =
  | "IntentOpened"
  | "IntentClaimed"
  | "IntentChallenged"
  | "IntentResolved"
  | "IntentFinalized"
  | "IntentRefunded"
  | "CctpBurn"
  | "CctpMint"
  | "Delivery";

/** Normalized shape every chain watcher publishes, regardless of source chain — mirrors
 *  packages/db's `escrow_events` table (packages/db/src/schema.ts). `payload` carries whatever
 *  chain- and event-specific fields the raw log/event had (kept loose here deliberately; typed
 *  narrowing happens at the consumer, per event type, not at the bus layer). */
export interface ChainEvent {
  /** Dedup key, e.g. `${chainId}:${txRef}:${logIndex}`. Used as the Kafka message key so
   *  same-key events land on the same partition and retries are naturally idempotent. */
  id: string;
  chainId: number;
  /** null for events not tied to an intent, e.g. a plain CCTP-direct-rail burn. */
  intentHash: string | null;
  eventType: ChainEventType;
  txRef: string;
  /** Stringified bigint for safe JSON transport. */
  blockOrLedgerNumber: string | null;
  /** ISO 8601. */
  observedAt: string;
  payload: Record<string, unknown>;
}
