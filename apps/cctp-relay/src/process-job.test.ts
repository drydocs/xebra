import {
  type IrisClient,
  type IrisMessage,
  type MintSubmitter,
  createQueuedJob,
} from "@xebra/cctp-client";
import { describe, expect, it, vi } from "vitest";
import { InMemoryRelayJobStore } from "./job-store.js";
import { processJob } from "./process-job.js";

const OPTS = { pollIntervalMs: 1000, maxAttempts: 3 };

function deps(overrides: { iris?: IrisClient; mint?: MintSubmitter } = {}) {
  return {
    iris: overrides.iris ?? { getMessages: vi.fn(async () => []) },
    mint: overrides.mint ?? { submitReceiveMessage: vi.fn(async () => ({ signature: "sig" })) },
    store: new InMemoryRelayJobStore(),
    pollIntervalMs: OPTS.pollIntervalMs,
    maxAttempts: OPTS.maxAttempts,
  };
}

describe("processJob", () => {
  it("persists the advanced job and requeues while waiting on attestation", async () => {
    const d = deps();
    const job = createQueuedJob({ id: "job-1", sourceDomainId: 2, sourceTxHash: "0xabc" });

    const result = await processJob(job, d);

    expect(result.job.status).toBe("waiting_attestation");
    expect(result.decision).toEqual({ type: "requeue", delayMs: 1000 });
    expect(await d.store.get("job-1")).toEqual(result.job);
  });

  it("marks done once the mint is submitted", async () => {
    const attested: IrisMessage = {
      message: "0xdead",
      attestation: "0xbeef",
      eventNonce: "1",
      status: "complete",
    };
    const d = deps({ iris: { getMessages: vi.fn(async () => [attested]) } });
    const job = createQueuedJob({ id: "job-2", sourceDomainId: 2, sourceTxHash: "0xabc" });

    const result = await processJob(job, d);

    expect(result.job.status).toBe("submitted");
    expect(result.decision).toEqual({ type: "done" });
  });

  it("dead-letters after exceeding max attempts", async () => {
    const attested: IrisMessage = {
      message: "0xdead",
      attestation: "0xbeef",
      eventNonce: "1",
      status: "complete",
    };
    const d = deps({
      iris: { getMessages: vi.fn(async () => [attested]) },
      mint: {
        submitReceiveMessage: vi.fn(async () => {
          throw new Error("blockhash not found");
        }),
      },
    });
    const job = {
      ...createQueuedJob({ id: "job-3", sourceDomainId: 2, sourceTxHash: "0xabc" }),
      attempts: 2,
    };

    const result = await processJob(job, d);

    expect(result.job.status).toBe("failed");
    expect(result.job.attempts).toBe(3);
    expect(result.decision.type).toBe("dead-letter");
  });
});
