import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Relay state.
 *
 * # Why Convex rather than Postgres
 *
 * The relay is a retrying job pipeline that has to survive between invocations, and the deployed
 * app is serverless. Postgres can do that, but every serverless-specific problem — a connection
 * per invocation, `FOR UPDATE SKIP LOCKED` to keep two overlapping workers apart — is work spent
 * on the storage engine rather than the corridor. Convex mutations are serializable, so a
 * read-then-write is simply atomic, and its scheduler runs at minute granularity on the free
 * plan where Vercel Cron would only run daily.
 *
 * `@xebra/relay-core/postgres` still exists for anyone self-hosting the container relay. Both
 * satisfy the same interfaces, so the code that moves money is identical either way.
 *
 * # This holds no funds and no keys
 *
 * Transaction hashes, Circle's signed attestation, a status and timestamps. Losing this database
 * costs the relay its memory of in-flight transfers, which is recoverable by re-submitting the
 * hashes — the attestation is public and never expires, so nobody's money depends on it.
 */

export default defineSchema({
  relayJobs: defineTable({
    /** Our own job id, not Convex's `_id`: it is the identifier that travels through
     *  `RelayJobState` and appears in logs and API responses, and it must stay stable
     *  independently of the row's storage identity. */
    jobId: v.string(),
    sourceDomainId: v.number(),
    sourceTxHash: v.string(),
    status: v.string(),
    /** Circle's attested message and signature, kept so a restart resumes without re-querying
     *  Iris and so the pair stays available for a manual claim. */
    message: v.optional(v.string()),
    attestation: v.optional(v.string()),
    destTxSignature: v.optional(v.string()),
    attempts: v.number(),
    lastError: v.optional(v.string()),
    createdAt: v.number(),
    /** The retry schedule — what a BullMQ delay used to be. */
    nextAttemptAt: v.number(),
    /**
     * Held by whichever invocation is currently working this job.
     *
     * Still needed despite serializable mutations, because Convex *actions* are not
     * transactional: they call out to Iris and Solana, and two actions could otherwise work the
     * same job and submit the same mint twice. The claim itself is a mutation, so taking the
     * lease is atomic; the lease is what stops the non-transactional part from overlapping.
     *
     * A crashed action needs no cleanup — the lease simply lapses.
     */
    leasedUntil: v.optional(v.number()),
  })
    /** The natural key. One burn produces exactly one mint, so this is what makes a re-scan, a
     *  retried submission or two overlapping ticks a no-op instead of a second paid mint. */
    .index("by_source", ["sourceDomainId", "sourceTxHash"])
    .index("by_job_id", ["jobId"])
    /** The sweep's access path: unfinished jobs in due order. */
    .index("by_status_and_due", ["status", "nextAttemptAt"])
    /** Counting recent jobs, for the sponsorship cap. */
    .index("by_created", ["createdAt"]),

  /** Where the Soroban event scan got to. Soroban RPC keeps only about 24 hours of events, so
   *  losing this does not just lose our place — it resumes from a ledger that has fallen out of
   *  retention and silently skips every burn in between. */
  watcherCursors: defineTable({
    name: v.string(),
    cursor: v.string(),
  }).index("by_name", ["name"]),
});
