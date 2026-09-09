import { and, eq, gte, sql } from "drizzle-orm";
import type { RelayJobState, RelayJobStatus } from "@xebra/cctp-client";
import { type Database, relayJobs } from "@xebra/db";
import type { RelayJobStore } from "./job-store.js";
import type { ScheduleDecision } from "./schedule.js";

/**
 * Postgres-backed relay job state.
 *
 * # Why the in-memory store is not good enough
 *
 * `InMemoryRelayJobStore` is a `Map`. A relay restart between a burn and its mint forgets the
 * job entirely — the user's USDC stays burned and claimable, but nothing is watching to claim
 * it. Every deploy, crash or scale event silently strands whatever was in flight.
 *
 * # Idempotency lives here, not in the caller
 *
 * `relay-job.ts` documents idempotency as the job store's responsibility. The unique index on
 * `(source_domain_id, source_tx_hash)` is what actually enforces it: a burn watcher that
 * re-scans a ledger range, or two relay instances racing, cannot create two jobs for the same
 * burn. `upsertBySourceTx` returns the existing job rather than failing, so a duplicate tick is
 * a no-op instead of an error to handle.
 *
 * The chain enforces this too — `used_nonce` makes a second mint impossible — but that costs a
 * transaction fee to discover. Catching it here costs nothing.
 */

function toRow(job: RelayJobState) {
  return {
    id: job.id,
    sourceDomainId: job.sourceDomainId,
    sourceTxHash: job.sourceTxHash,
    status: job.status,
    message: job.message ?? null,
    attestation: job.attestation ?? null,
    destTxSignature: job.destTxSignature ?? null,
    attempts: job.attempts,
    lastError: job.lastError ?? null,
    // `createdAt` is epoch-ms in the domain type and timestamptz in SQL. Converting here keeps
    // the mismatch in one place rather than leaking Date handling into the state machine.
    createdAt: new Date(job.createdAt),
    updatedAt: new Date(),
  };
}

function fromRow(row: Record<string, unknown>): RelayJobState {
  const created = row.createdAt;
  // Optional fields are assigned only when present: `exactOptionalPropertyTypes` treats an
  // explicit `undefined` as different from an absent key, and a NULL column must map to absent.
  const state: RelayJobState = {
    id: String(row.id),
    sourceDomainId: Number(row.sourceDomainId),
    sourceTxHash: String(row.sourceTxHash),
    status: String(row.status) as RelayJobStatus,
    attempts: Number(row.attempts ?? 0),
    createdAt: created instanceof Date ? created.getTime() : Number(created),
  };
  if (row.message) state.message = row.message as `0x${string}`;
  if (row.attestation) state.attestation = row.attestation as `0x${string}`;
  if (row.destTxSignature) state.destTxSignature = String(row.destTxSignature);
  if (row.lastError) state.lastError = String(row.lastError);
  return state;
}

export class PostgresRelayJobStore implements RelayJobStore {
  constructor(private readonly db: Database) {}

  /**
   * Writes the job, overwriting by primary key. The state machine calls this after every
   * transition, so this is an upsert rather than an insert — a retry that re-saves the same
   * job must not fail.
   */
  async save(job: RelayJobState): Promise<void> {
    const row = toRow(job);
    await this.db
      .insert(relayJobs)
      .values(row)
      .onConflictDoUpdate({
        target: relayJobs.id,
        set: {
          status: row.status,
          message: row.message,
          attestation: row.attestation,
          destTxSignature: row.destTxSignature,
          attempts: row.attempts,
          lastError: row.lastError,
          updatedAt: row.updatedAt,
        },
      })
      .returning();
  }

  async get(id: string): Promise<RelayJobState | undefined> {
    const rows = await this.db.select().from(relayJobs).where(eq(relayJobs.id, id)).limit(1);
    const row = rows[0];
    return row ? fromRow(row) : undefined;
  }

  /**
   * Creates a job for a burn, or returns the one that already exists.
   *
   * This is what a burn watcher calls. Re-scanning a ledger range must be safe: the unique
   * index turns a duplicate into a no-op rather than a second mint attempt.
   */
  async upsertBySourceTx(job: RelayJobState): Promise<{ job: RelayJobState; created: boolean }> {
    const inserted = await this.db
      .insert(relayJobs)
      .values(toRow(job))
      .onConflictDoNothing()
      .returning();

    if (inserted.length > 0) return { job: fromRow(inserted[0] as Record<string, unknown>), created: true };

    const existing = await this.db
      .select()
      .from(relayJobs)
      .where(
        and(
          eq(relayJobs.sourceDomainId, job.sourceDomainId),
          eq(relayJobs.sourceTxHash, job.sourceTxHash),
        ),
      )
      .limit(1);

    const row = existing[0];
    if (!row) {
      // Insert reported a conflict but no row matches the natural key — the conflict was on
      // the primary key with different burn details, which means two different burns were
      // assigned the same job id. Silently continuing would mint against the wrong message.
      throw new Error(
        `Job id ${job.id} already exists for a different burn than ` +
          `${job.sourceDomainId}:${job.sourceTxHash}`,
      );
    }
    return { job: fromRow(row), created: false };
  }

  /**
   * Takes up to `limit` due jobs and leases them, atomically.
   *
   * `FOR UPDATE SKIP LOCKED` is what makes this safe to call from two invocations at once: the
   * second skips the rows the first is holding rather than blocking on them or, worse, reading
   * them and minting the same message twice. The chain would reject the duplicate via
   * `used_nonce`, but only after charging a transaction fee to find out.
   *
   * A job is due when its `next_attempt_at` has passed and its lease has lapsed (or was never
   * taken). Terminal states are excluded, so a completed job is never re-examined; `failed` is
   * not terminal, because `decideNextStep` retries it until the attempt limit.
   *
   * The lease means a crashed invocation needs no cleanup: its rows simply become claimable
   * again when the lease expires.
   */
  async claimDueJobs(limit: number, leaseMs: number): Promise<RelayJobState[]> {
    const rows = await this.db.execute(sql`
      WITH due AS (
        SELECT id FROM ${relayJobs}
        WHERE status IN ('queued', 'waiting_attestation', 'failed')
          AND next_attempt_at <= now()
          AND (leased_until IS NULL OR leased_until <= now())
        ORDER BY next_attempt_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      UPDATE ${relayJobs} AS j
      SET leased_until = now() + ${sql.raw(`interval '${Math.max(1, Math.round(leaseMs / 1000))} seconds'`)}
      FROM due
      WHERE j.id = due.id
      RETURNING j.*
    `);

    // postgres-js returns the rows themselves; the driver wrapper may wrap them in `.rows`.
    const list = Array.isArray(rows)
      ? rows
      : ((rows as { rows?: unknown[] }).rows ?? []);
    return (list as Array<Record<string, unknown>>).map(fromSnakeRow);
  }

  /**
   * How many mints this relay has sponsored since `since`, for the spend cap in `admission.ts`.
   *
   * Counted from `created_at` rather than a completion timestamp: the cap exists to bound what we
   * are on the hook for, and a job that has been accepted is already committed to costing rent
   * whether or not it has reached `submitted` yet.
   */
  async countSponsoredSince(since: number): Promise<number> {
    const rows = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(relayJobs)
      .where(gte(relayJobs.createdAt, new Date(since)));
    return Number(rows[0]?.count ?? 0);
  }

  /**
   * Applies a schedule decision.
   *
   * The lease is always cleared. A job left leased after its decision would be invisible until
   * the lease lapsed, which for a job asked to retry immediately means sitting idle for minutes.
   *
   * A dead-lettered job is parked far in the future rather than deleted or given a new status:
   * the row is the only record that a burn was seen and abandoned, and it is what an operator
   * needs to re-drive it by hand.
   */
  async reschedule(job: RelayJobState, decision: ScheduleDecision): Promise<void> {
    const next =
      decision.type === "requeue"
        ? new Date(Date.now() + decision.delayMs)
        : decision.type === "dead-letter"
          ? new Date(Date.now() + DEAD_LETTER_PARK_MS)
          : new Date();

    await this.db
      .update(relayJobs)
      .set({
        nextAttemptAt: next,
        leasedUntil: null,
        updatedAt: new Date(),
        ...(decision.type === "dead-letter" ? { lastError: decision.reason } : {}),
      })
      .where(eq(relayJobs.id, job.id));
  }
}

/** A job that has given up is parked a century out rather than deleted, so `claimDueJobs` will
 *  never pick it up again but the row survives for anyone investigating. */
const DEAD_LETTER_PARK_MS = 100 * 365 * 24 * 60 * 60 * 1000;

/** Raw SQL returns snake_case columns, unlike Drizzle's mapped selects. */
function fromSnakeRow(row: Record<string, unknown>): RelayJobState {
  return fromRow({
    id: row.id,
    sourceDomainId: row.source_domain_id,
    sourceTxHash: row.source_tx_hash,
    status: row.status,
    message: row.message,
    attestation: row.attestation,
    destTxSignature: row.dest_tx_signature,
    attempts: row.attempts,
    lastError: row.last_error,
    createdAt: row.created_at,
  });
}
