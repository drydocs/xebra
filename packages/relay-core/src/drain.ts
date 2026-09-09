import type { RelayJobState } from "@xebra/cctp-client";
import { type ProcessJobDeps, processJob } from "./process-job.js";
import type { ScheduleDecision } from "./schedule.js";

/**
 * Runs every relay job that is due, then stops.
 *
 * # Why this exists alongside the BullMQ worker
 *
 * BullMQ's delayed jobs need Redis and a process that stays alive to consume them. The
 * deployment target here is Vercel: no Redis, no long-lived process, and a function that is
 * killed when it returns. So the queue is two columns on `relay_jobs` — `next_attempt_at` and
 * `leased_until` — and this function is the consumer, invoked by cron and again inline after a
 * burn is submitted.
 *
 * The retry policy is unchanged. `decideNextStep` still decides; the only difference is that a
 * "requeue in 5s" becomes a timestamp rather than a Redis delay.
 *
 * # Why it is bounded three ways
 *
 * A serverless invocation is killed at its `maxDuration` with no warning and no chance to
 * finish. Anything not durable at that moment is lost, so the loop stops early rather than being
 * cut off mid-job:
 *
 *   - `maxJobs` caps how many are attempted per invocation.
 *   - `budgetMs` stops starting new jobs once the invocation is close to its limit.
 *   - Every job's state is persisted by `processJob` before the next one starts, so a kill
 *     between jobs loses nothing but time.
 *
 * # Why a job is leased, not just claimed
 *
 * Cron and the inline drain can overlap, and Vercel will happily run two invocations at once.
 * `claimDueJobs` hands out a lease; a leased row is invisible to other callers until it expires.
 * Without it both callers would submit the same mint, and the second would pay a transaction fee
 * to be rejected by `used_nonce`. The chain protects the funds; the lease protects the wallet.
 */

export interface DrainDeps extends ProcessJobDeps {
  /**
   * Atomically takes up to `limit` due jobs and leases them for `leaseMs`. Returning fewer than
   * `limit` means fewer were due, which is how the loop knows to stop.
   */
  claimDueJobs(limit: number, leaseMs: number): Promise<RelayJobState[]>;
  /** Records the decision: a new `next_attempt_at`, or the end of the job's life. */
  reschedule(job: RelayJobState, decision: ScheduleDecision): Promise<void>;
  now?: () => number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface DrainOptions {
  /** Hard cap on jobs per invocation. */
  maxJobs?: number;
  /** Stop starting new jobs once this much wall-clock time has been used. */
  budgetMs?: number;
  /** How long a claimed job stays invisible to other callers. Must comfortably exceed the time
   *  one job takes, or a slow mint gets picked up twice while the first is still in flight. */
  leaseMs?: number;
  /** How many jobs to claim per round trip. */
  batchSize?: number;
}

export interface DrainResult {
  processed: number;
  completed: number;
  deadLettered: number;
  requeued: number;
  /** True when the loop stopped on a limit rather than because nothing was due — the caller
   *  should expect more work waiting, and may choose to drain again immediately. */
  stoppedEarly: boolean;
}

export async function drainDueJobs(
  deps: DrainDeps,
  options: DrainOptions = {},
): Promise<DrainResult> {
  const maxJobs = options.maxJobs ?? 25;
  const budgetMs = options.budgetMs ?? 45_000;
  const leaseMs = options.leaseMs ?? 120_000;
  const batchSize = Math.min(options.batchSize ?? 5, maxJobs);
  const now = deps.now ?? Date.now;

  const startedAt = now();
  const result: DrainResult = {
    processed: 0,
    completed: 0,
    deadLettered: 0,
    requeued: 0,
    stoppedEarly: false,
  };

  while (result.processed < maxJobs) {
    if (now() - startedAt >= budgetMs) {
      result.stoppedEarly = true;
      break;
    }

    const remaining = maxJobs - result.processed;
    const batch = await deps.claimDueJobs(Math.min(batchSize, remaining), leaseMs);
    if (batch.length === 0) break;

    for (const claimed of batch) {
      // Checked per job, not per batch: one slow mint can consume most of the budget on its own,
      // and starting another after that risks being killed part-way through submitting it.
      if (now() - startedAt >= budgetMs) {
        result.stoppedEarly = true;
        // Give the unprocessed remainder of the batch back rather than leaving it leased for the
        // full lease window, which would idle it past several cron ticks.
        await deps.reschedule(claimed, { type: "requeue", delayMs: 0 });
        continue;
      }

      let decision: ScheduleDecision;
      try {
        const outcome = await processJob(claimed, deps);
        decision = outcome.decision;
        deps.log?.("processed relay job", {
          jobId: outcome.job.id,
          status: outcome.job.status,
          decision: decision.type,
        });
      } catch (err) {
        // `processJob` persists before deciding, so a throw here means the *store* failed or
        // something outside the state machine did. Retrying with backoff is right; dropping the
        // job because an unexpected error escaped is not.
        decision = { type: "requeue", delayMs: 30_000 };
        deps.log?.("relay job threw", {
          jobId: claimed.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      await deps.reschedule(claimed, decision);
      result.processed++;
      if (decision.type === "done") result.completed++;
      else if (decision.type === "dead-letter") result.deadLettered++;
      else result.requeued++;
    }
  }

  if (result.processed >= maxJobs) result.stoppedEarly = true;
  return result;
}
