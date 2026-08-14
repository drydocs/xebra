import type { Database } from "@xebra/db";
import { claims, escrowEvents, intents } from "@xebra/db";
import type { ChainEvent } from "@xebra/event-bus";
import { eq } from "drizzle-orm";
import type { Logger } from "pino";
import {
  projectIntentChallenged,
  projectIntentClaimed,
  projectIntentResolved,
} from "./project-claim.js";
import { projectIntentOpened } from "./project-intent-opened.js";

/**
 * Populates packages/db's tables from the event backbone — the piece flagged as a known gap
 * throughout the rest of this codebase (see repo README's Status section, apps/solver's and
 * apps/arbiter-service's module doc comments). Idempotent by design: `intents`/`claims` inserts
 * use `onConflictDoNothing` (an event redelivered — Kafka's at-least-once delivery — shouldn't
 * error), and `escrow_events` is a pure append-only audit log keyed by the event's own dedup id,
 * so redelivery there is a harmless duplicate-key no-op too.
 *
 * `claims` is now populated (see project-claim.ts) — this is what unblocks
 * apps/arbiter-service's claim-verification lookup, per that file's own module doc comment.
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

  if (event.eventType === "IntentClaimed") {
    const row = projectIntentClaimed(event);
    if (!row) {
      logger.warn(
        { eventId: event.id },
        "projector: IntentClaimed event didn't match a known payload shape, skipping claims insert",
      );
    } else {
      await db.insert(claims).values(row).onConflictDoNothing();
    }
  }

  const claimUpdate =
    event.eventType === "IntentChallenged"
      ? projectIntentChallenged(event)
      : event.eventType === "IntentResolved"
        ? projectIntentResolved(event)
        : null;
  if (claimUpdate && event.intentHash) {
    try {
      await db.update(claims).set(claimUpdate).where(eq(claims.intentHash, event.intentHash));
    } catch (err) {
      // The claim row may not exist yet if this event was delivered out of order relative to
      // its IntentClaimed event — same out-of-order-delivery reasoning as the intents status
      // update below.
      logger.warn(
        { eventId: event.id, err },
        "projector: claims update failed, possibly out-of-order delivery",
      );
    }
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
