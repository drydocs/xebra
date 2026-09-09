import { type RelayJobState, createQueuedJob } from "@xebra/cctp-client";
import { describe, expect, it } from "vitest";
import { decideNextStep } from "./schedule.js";

const OPTS = { pollIntervalMs: 5000, maxAttempts: 3 };
const BASE = createQueuedJob({ id: "job-1", sourceDomainId: 2, sourceTxHash: "0xabc" });

describe("decideNextStep", () => {
  it("requeues immediately for a freshly queued job", () => {
    expect(decideNextStep(BASE, OPTS)).toEqual({ type: "requeue", delayMs: 0 });
  });

  it("requeues after the poll interval while waiting on attestation", () => {
    const job: RelayJobState = { ...BASE, status: "waiting_attestation" };
    expect(decideNextStep(job, OPTS)).toEqual({ type: "requeue", delayMs: 5000 });
  });

  it("is done once submitted", () => {
    const job: RelayJobState = { ...BASE, status: "submitted" };
    expect(decideNextStep(job, OPTS)).toEqual({ type: "done" });
  });

  it("backs off exponentially on failure, capped at 10x the poll interval", () => {
    // A generous maxAttempts here isolates the backoff formula from the dead-letter cutoff
    // (tested separately below) — attempts 1/2/5 must all still be in "retry" territory.
    const generousOpts = { ...OPTS, maxAttempts: 10 };
    const attempt1: RelayJobState = { ...BASE, status: "failed", attempts: 1 };
    const attempt2: RelayJobState = { ...BASE, status: "failed", attempts: 2 };
    const attempt5: RelayJobState = { ...BASE, status: "failed", attempts: 5 };

    expect(decideNextStep(attempt1, generousOpts)).toEqual({ type: "requeue", delayMs: 10000 });
    expect(decideNextStep(attempt2, generousOpts)).toEqual({ type: "requeue", delayMs: 20000 });
    // 2^5 * 5000 = 160000, capped at 10x = 50000
    expect(decideNextStep(attempt5, generousOpts)).toEqual({ type: "requeue", delayMs: 50000 });
  });

  it("dead-letters once max attempts is exceeded", () => {
    const job: RelayJobState = {
      ...BASE,
      status: "failed",
      attempts: 3,
      lastError: "insufficient SOL",
    };
    const decision = decideNextStep(job, OPTS);
    expect(decision.type).toBe("dead-letter");
    if (decision.type === "dead-letter") {
      expect(decision.reason).toMatch(/insufficient SOL/);
    }
  });
});
