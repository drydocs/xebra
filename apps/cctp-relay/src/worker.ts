import type { Meter } from "@opentelemetry/api";
import type { RelayJobState } from "@xebra/cctp-client";
import { type ConnectionOptions, Queue, Worker } from "bullmq";
import type { Logger } from "pino";
import { type ProcessJobDeps, type RelayJobStore, processJob } from "@xebra/relay-core";

const QUEUE_NAME = "cctp-relay";

export interface StartWorkerOptions {
  connection: ConnectionOptions;
  deps: Omit<ProcessJobDeps, "store"> & { store: RelayJobStore };
  logger: Logger;
  /** Optional — when provided, records docs/architecture.md §11's "CCTP attestation pending
   *  past threshold" alert signal on every processed job still waiting on Iris. */
  meter?: Meter;
}

/**
 * Thin BullMQ shell around `processJob` (the actual, unit-tested pipeline logic). This file's
 * job is queue mechanics only: pull a job, call processJob, act on its ScheduleDecision.
 */
export function startWorker({ connection, deps, logger, meter }: StartWorkerOptions): {
  queue: Queue;
  worker: Worker;
} {
  const queue = new Queue<RelayJobState>(QUEUE_NAME, { connection });
  const attestationAgeGauge = meter?.createGauge("cctp_attestation_pending_age_ms", {
    description:
      "Time since a relay job was queued, for jobs still waiting on Circle's Iris attestation.",
  });

  const worker = new Worker<RelayJobState>(
    QUEUE_NAME,
    async (job) => {
      const result = await processJob(job.data, deps);
      logger.info(
        { jobId: result.job.id, status: result.job.status, decision: result.decision },
        "cctp-relay: processed job",
      );

      if (result.job.status === "waiting_attestation") {
        attestationAgeGauge?.record(Date.now() - result.job.createdAt, { jobId: result.job.id });
      }

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
