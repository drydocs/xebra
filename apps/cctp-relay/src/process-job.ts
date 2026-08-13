import type { IrisClient, MintSubmitter, RelayJobState } from "@xebra/cctp-client";
import { advanceRelayJob } from "@xebra/cctp-client";
import type { RelayJobStore } from "./job-store.js";
import { type ScheduleDecision, decideNextStep } from "./schedule.js";

/**
 * One step of the relay pipeline: advance the job, persist it, decide what happens next. This
 * is what the BullMQ `Worker` in worker.ts calls per job attempt — kept separate from BullMQ's
 * `Job` type so it's unit-testable with a plain `RelayJobState` and no live Redis connection.
 */

export interface ProcessJobDeps {
  iris: IrisClient;
  mint: MintSubmitter;
  store: RelayJobStore;
  pollIntervalMs: number;
  maxAttempts: number;
}

export interface ProcessJobResult {
  job: RelayJobState;
  decision: ScheduleDecision;
}

export async function processJob(
  job: RelayJobState,
  deps: ProcessJobDeps,
): Promise<ProcessJobResult> {
  const advanced = await advanceRelayJob(job, { iris: deps.iris, mint: deps.mint });
  await deps.store.save(advanced);
  const decision = decideNextStep(advanced, {
    pollIntervalMs: deps.pollIntervalMs,
    maxAttempts: deps.maxAttempts,
  });
  return { job: advanced, decision };
}
