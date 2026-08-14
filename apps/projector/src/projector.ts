import type { Database } from "@xebra/db";
import { escrowEvents, intents } from "@xebra/db";
import type { ChainEvent } from "@xebra/event-bus";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import { projectIntentOpened } from "./project-intent-opened.js";

/**
 * Populates packages/db's tables from the event backbone — the piece flagged as a known gap
 * throughout the rest of this codebase (see repo README's Status section, apps/solver's and
 * apps/arbiter-service's module doc comments). Idempotent by design: `intents` inserts use
 * `onConflictDoNothing` (an IntentOpened event redelivered — Kafka's at-least-once delivery —
 * shouldn't error), and `escrow_events` is a pure append-only audit log keyed by the event's own
 * dedup id, so redelivery there is a harmless duplicate-key no-op too.
 *
 * Status transitions for non-Opened events (Claimed/Challenged/Resolved/Finalized/Refunded) are
 * intentionally the only thing projected for those event types right now — updating `claims`
 * with full field detail (solver address, delivered amount, challenge bond/timestamps) is real
 * work with its own per-chain payload-shape mapping (mirroring project-intent-opened.ts's
 * Arc-vs-Soroban split) that didn't fit this pass; `intents.status` alone is enough to unblock
 * apps/api's status queries, which is the most load-bearing gap this closes first.
 */

const STATUS_BY_EVENT_TYPE: Partial<Record<ChainEvent["eventType"], string>> = {
  IntentClaimed: "claimed",
  IntentChallenged: "challenged",
  IntentFinalized: "finalized",
  IntentRefunded: "refunded",
};

export async function projectEvent(db: Database, event: ChainEvent, logger: Logger): Promise<void> {
  if (event.eventType === "IntentOpened") {
    const row = projectIntentOpened(event);
    if (!row) {
      logger.warn(
        { eventId: event.id },
        "projector: IntentOpened event didn't match a known payload shape, skipping",
      );
      return;
    }
    await db.insert(intents).values(row).onConflictDoNothing();
  }

  const newStatus = STATUS_BY_EVENT_TYPE[event.eventType];
  if (newStatus && event.intentHash) {
    try {
      await db
        .update(intents)
        .set({ status: newStatus as (typeof intents.$inferSelect)["status"] })
        .where(eq(intents.intentHash, event.intentHash));
    } catch (err) {
      // The intent row may not exist yet if this event was delivered out of order relative to
      // its IntentOpened event (Kafka partitions by event id, not intentHash, so strict
      // per-intent ordering isn't guaranteed — see this file's module doc comment) — log and
      // move on rather than crash the consumer over a transient ordering race.
      logger.warn(
        { eventId: event.id, err },
        "projector: status update failed, possibly out-of-order delivery",
      );
    }
  }

  if (event.intentHash) {
    try {
      await db
        .insert(escrowEvents)
        .values({
          id: event.id,
          intentHash: event.intentHash,
          chainId: event.chainId,
          eventType: event.eventType,
          txRef: event.txRef,
          blockOrLedgerNumber: event.blockOrLedgerNumber ? BigInt(event.blockOrLedgerNumber) : null,
        })
        .onConflictDoNothing();
    } catch (err) {
      logger.warn(
        { eventId: event.id, err },
        "projector: escrow_events insert failed, possibly out-of-order delivery",
      );
    }
  }
}
