import type { RelayJobState } from "@xebra/cctp-client";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import type { Logger } from "pino";
import type { RelayJobStore } from "./job-store.js";
import { type ProcessJobDeps, processJob } from "./process-job.js";

const QUEUE_NAME = "cctp-relay";

export interface StartWorkerOptions {
  connection: ConnectionOptions;
  deps: Omit<ProcessJobDeps, "store"> & { store: RelayJobStore };
  logger: Logger;
}

/**
 * Thin BullMQ shell around `processJob` (the actual, unit-tested pipeline logic). This file's
 * job is queue mechanics only: pull a job, call processJob, act on its ScheduleDecision.
 */
export function startWorker({ connection, deps, logger }: StartWorkerOptions): {
  queue: Queue;
  worker: Worker;
} {
  const queue = new Queue<RelayJobState>(QUEUE_NAME, { connection });

  const worker = new Worker<RelayJobState>(
    QUEUE_NAME,
    async (job) => {
      const result = await processJob(job.data, deps);
      logger.info(
        { jobId: result.job.id, status: result.job.status, decision: result.decision },
        "cctp-relay: processed job",
      );

      switch (result.decision.type) {
        case "requeue":
          await queue.add(result.job.id, result.job, { delay: result.decision.delayMs });
          break;
        case "dead-letter":
          logger.error(
            { jobId: result.job.id, reason: result.decision.reason },
            "cctp-relay: dead-lettered",
          );
          break;
        case "done":
          break;
      }

      return result.job;
    },
    { connection },
  );

  worker.on("failed", (job, err) => {
    logger.error({ jobId: job?.id, err: err.message }, "cctp-relay: worker job threw");
  });

  return { queue, worker };
}

/** Enqueues a brand-new relay job for a burn tx that was just observed (see
 *  apps/indexer-stellar, docs/architecture.md §8) — the entry point into this queue. */
export async function enqueueRelayJob(
  queue: Queue<RelayJobState>,
  job: RelayJobState,
): Promise<void> {
  await queue.add(job.id, job, { jobId: job.id });
}
