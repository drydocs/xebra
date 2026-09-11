import type { RelayJobState, RelayJobStatus } from "@xebra/cctp-client";
import { v } from "convex/values";
import type { Doc } from "./_generated/dataModel";
import { internalMutation, internalQuery, query } from "./_generated/server";

/**
 * Every read and write of relay job state.
 *
 * All `internal*`: nothing here is callable from a browser. The public surface is `relay.ts`'s
 * `submitBurn`, which applies admission checks first — these functions would let a caller create
 * or complete jobs directly, which is to say spend the relay's SOL.
 *
 * The shape returned matches `RelayJobState` from `@xebra/cctp-client`, so the pipeline in
 * `@xebra/relay-core` runs unmodified against it.
 */

const jobFields = {
  jobId: v.string(),
  sourceDomainId: v.number(),
  sourceTxHash: v.string(),
  status: v.string(),
  message: v.optional(v.string()),
  attestation: v.optional(v.string()),
  destTxSignature: v.optional(v.string()),
  attempts: v.number(),
  lastError: v.optional(v.string()),
  createdAt: v.number(),
};

/**
 * Drops the Convex row identity and any absent optional field.
 *
 * Returns `RelayJobState` rather than a loose record on purpose: this type is what flows out
 * through `ctx.runMutation` into `@xebra/relay-core`, so typing it here is what lets the callers
 * be checked instead of cast. An untyped record forced `as RelayJobState` at every call site,
 * which is exactly the assertion that stops the compiler noticing a schema drift.
 *
 * Absent rather than `undefined` matters: a conditional spread omits the key entirely, which is
 * what `exactOptionalPropertyTypes` requires of consumers that distinguish the two.
 */
function toState(doc: Doc<"relayJobs">): RelayJobState {
  return {
    id: doc.jobId,
    sourceDomainId: doc.sourceDomainId,
    sourceTxHash: doc.sourceTxHash,
    status: doc.status as RelayJobStatus,
    attempts: doc.attempts,
    createdAt: doc.createdAt,
    ...(doc.message ? { message: doc.message as `0x${string}` } : {}),
    ...(doc.attestation ? { attestation: doc.attestation as `0x${string}` } : {}),
    ...(doc.destTxSignature ? { destTxSignature: doc.destTxSignature } : {}),
    ...(doc.lastError ? { lastError: doc.lastError } : {}),
  };
}

export const get = internalQuery({
  args: { jobId: v.string() },
  handler: async (ctx, { jobId }) => {
    const doc = await ctx.db
      .query("relayJobs")
      .withIndex("by_job_id", (q) => q.eq("jobId", jobId))
      .unique();
    return doc ? toState(doc) : null;
  },
});

/**
 * Creates a job for a burn, or returns the one that already exists.
 *
 * The read and the insert are one serializable mutation, so this is the whole of the idempotency
 * guarantee — two ticks racing, or a user retrying on a flaky network, cannot produce two jobs
 * for the same burn. Postgres needs a unique index for this because its read and write are
 * separate statements; here they are not.
 *
 * Without it a duplicate would reach the chain and be rejected by `used_nonce` — correctly, but
 * only after charging a transaction fee to find out.
 */
export const upsertBySourceTx = internalMutation({
  args: jobFields,
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("relayJobs")
      .withIndex("by_source", (q) =>
        q.eq("sourceDomainId", args.sourceDomainId).eq("sourceTxHash", args.sourceTxHash),
      )
      .unique();

    if (existing) return { job: toState(existing), created: false };

    // Due immediately: a new burn should be attempted in the same invocation that recorded it,
    // not on the next sweep.
    await ctx.db.insert("relayJobs", { ...args, nextAttemptAt: Date.now() });
    const inserted = await ctx.db
      .query("relayJobs")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!inserted) throw new Error(`job ${args.jobId} vanished immediately after insert`);
    return { job: toState(inserted), created: true };
  },
});

/** Persists a job after a pipeline step. Keyed on our job id, not the row id, because the caller
 *  only ever holds a `RelayJobState`. */
export const save = internalMutation({
  args: jobFields,
  handler: async (ctx, args) => {
    const doc = await ctx.db
      .query("relayJobs")
      .withIndex("by_job_id", (q) => q.eq("jobId", args.jobId))
      .unique();
    if (!doc) {
      await ctx.db.insert("relayJobs", { ...args, nextAttemptAt: Date.now() });
      return;
    }
    await ctx.db.patch(doc._id, {
      status: args.status,
      message: args.message,
      attestation: args.attestation,
      destTxSignature: args.destTxSignature,
      attempts: args.attempts,
      lastError: args.lastError,
    });
  },
});

/** Statuses still worth attempting. `failed` is not terminal — `decideNextStep` retries it until
 *  the attempt limit, at which point it is parked rather than deleted. */
const ACTIVE = ["queued", "waiting_attestation", "failed"];

/**
 * Takes up to `limit` due jobs and leases them.
 *
 * Serializable, so two invocations cannot claim the same job: the second sees the lease the first
 * wrote. This is the Convex equivalent of `FOR UPDATE SKIP LOCKED`, minus the lock.
 */
export const claimDue = internalMutation({
  args: { limit: v.number(), leaseMs: v.number() },
  handler: async (ctx, { limit, leaseMs }) => {
    const now = Date.now();
    const claimed = [];

    for (const status of ACTIVE) {
      if (claimed.length >= limit) break;
      const candidates = await ctx.db
        .query("relayJobs")
        .withIndex("by_status_and_due", (q) => q.eq("status", status).lte("nextAttemptAt", now))
        .order("asc")
        .take(limit - claimed.length);

      for (const doc of candidates) {
        if (doc.leasedUntil && doc.leasedUntil > now) continue;
        await ctx.db.patch(doc._id, { leasedUntil: now + leaseMs });
        claimed.push(toState(doc));
      }
    }

    return claimed;
  },
});

/**
 * Applies a schedule decision.
 *
 * The lease is always cleared, or a job told to retry immediately would sit invisible until the
 * lease lapsed. A job that has given up is parked far in the future rather than deleted: the row
 * is the only record that a burn was seen and abandoned, and it is what is needed to re-drive it
 * by hand.
 */
export const reschedule = internalMutation({
  args: {
    jobId: v.string(),
    delayMs: v.optional(v.number()),
    deadLetterReason: v.optional(v.string()),
  },
  handler: async (ctx, { jobId, delayMs, deadLetterReason }) => {
    const doc = await ctx.db
      .query("relayJobs")
      .withIndex("by_job_id", (q) => q.eq("jobId", jobId))
      .unique();
    if (!doc) return;

    const PARKED = 100 * 365 * 24 * 60 * 60 * 1000;
    const nextAttemptAt =
      deadLetterReason !== undefined ? Date.now() + PARKED : Date.now() + (delayMs ?? 0);

    await ctx.db.patch(doc._id, {
      nextAttemptAt,
      leasedUntil: undefined,
      ...(deadLetterReason !== undefined ? { lastError: deadLetterReason } : {}),
    });
  },
});

/**
 * How many jobs were accepted since `since`, for the sponsorship cap in `admission.ts`.
 *
 * Counted from creation rather than completion: the cap bounds what the relay is on the hook for,
 * and an accepted job is already committed to costing rent whether or not it has minted yet.
 */
export const countSponsoredSince = internalQuery({
  args: { since: v.number() },
  handler: async (ctx, { since }) => {
    const rows = await ctx.db
      .query("relayJobs")
      .withIndex("by_created", (q) => q.gte("createdAt", since))
      .collect();
    return rows.length;
  },
});

/**
 * The delivery status of one burn, for the receipt to poll.
 *
 * Public, unlike everything else here, and safe to be: it takes a burn hash the caller must
 * already have, and returns only what that burn did. It creates nothing and spends nothing.
 *
 * It exists so the receipt can stop guessing. Without it the UI could say a transfer was
 * "waiting" but never learn that it had landed, which is a spinner that never ends — a worse
 * lie than the wrong error message it replaced.
 */
export const statusByBurn = query({
  args: { sourceDomainId: v.number(), sourceTxHash: v.string() },
  handler: async (ctx, { sourceDomainId, sourceTxHash }) => {
    const doc = await ctx.db
      .query("relayJobs")
      .withIndex("by_source", (q) =>
        q.eq("sourceDomainId", sourceDomainId).eq("sourceTxHash", sourceTxHash),
      )
      .unique();

    // Absent means the watcher has not reached this burn yet, which on a fresh burn is the
    // normal state for up to a minute — not a failure, and deliberately not reported as one.
    if (!doc) return null;

    return {
      status: doc.status,
      destTxSignature: doc.destTxSignature ?? null,
      attempts: doc.attempts,
    };
  },
});
