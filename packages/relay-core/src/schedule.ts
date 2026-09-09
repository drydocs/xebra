import type { RelayJobState } from "@xebra/cctp-client";

/**
 * Pure decision function: given a job's state after one `advanceRelayJob` step, what should the
 * BullMQ wiring do next? Kept separate from the queue mechanics so the retry/backoff/dead-letter
 * policy is unit-testable without a real Redis connection.
 */
export type ScheduleDecision =
  | { type: "requeue"; delayMs: number }
  | { type: "done" }
  | { type: "dead-letter"; reason: string };

export function decideNextStep(
  job: RelayJobState,
  opts: { pollIntervalMs: number; maxAttempts: number },
): ScheduleDecision {
  switch (job.status) {
    case "waiting_attestation":
      return { type: "requeue", delayMs: opts.pollIntervalMs };
    case "submitted":
    case "confirmed":
      return { type: "done" };
    case "failed":
      if (job.attempts >= opts.maxAttempts) {
        return {
          type: "dead-letter",
          reason: `exceeded ${opts.maxAttempts} attempts; last error: ${job.lastError ?? "unknown"}`,
        };
      }
      // Exponential backoff, capped at 10x the base poll interval, so a transiently congested
      // Solana network doesn't get hammered with resubmissions.
      return {
        type: "requeue",
        delayMs: Math.min(opts.pollIntervalMs * 2 ** job.attempts, opts.pollIntervalMs * 10),
      };
    case "queued":
      return { type: "requeue", delayMs: 0 };
  }
}
