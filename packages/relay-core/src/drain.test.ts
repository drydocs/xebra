import { describe, expect, it, vi } from "vitest";
import { createQueuedJob, type RelayJobState } from "@xebra/cctp-client";
import { drainDueJobs, type DrainDeps } from "./drain.js";
import type { ScheduleDecision } from "./schedule.js";

function job(id: string, overrides: Partial<RelayJobState> = {}): RelayJobState {
  return { ...createQueuedJob({ id, sourceDomainId: 27, sourceTxHash: id }, 1_000), ...overrides };
}

function deps(overrides: Partial<DrainDeps> = {}) {
  const rescheduled: Array<{ id: string; decision: ScheduleDecision }> = [];
  const attempted: string[] = [];
  const base: DrainDeps = {
    // Attested already, so one step reaches `submitted`, which `decideNextStep` calls done.
    iris: {
      getMessages: async () => [
        {
          status: "complete" as const,
          message: "0xaa" as `0x${string}`,
          attestation: "0xbb" as `0x${string}`,
        },
      ],
    } as unknown as DrainDeps["iris"],
    mint: {
      submitReceiveMessage: async () => ({ signature: "sig" }),
    },
    store: {
      save: async (j: RelayJobState) => {
        attempted.push(j.id);
      },
      get: async () => undefined,
    },
    pollIntervalMs: 5_000,
    maxAttempts: 10,
    claimDueJobs: async () => [],
    reschedule: async (j, decision) => {
      rescheduled.push({ id: j.id, decision });
    },
    ...overrides,
  };
  return { deps: base, rescheduled, attempted };
}

/** Hands out `batches` in order, then nothing — the shape a draining queue has. */
function batching(batches: RelayJobState[][]) {
  let i = 0;
  return async () => batches[i++] ?? [];
}

describe("drainDueJobs", () => {
  it("does nothing when nothing is due", async () => {
    const h = deps();
    expect(await drainDueJobs(h.deps)).toMatchObject({ processed: 0, stoppedEarly: false });
  });

  it("keeps claiming until the queue is empty", async () => {
    // A serverless invocation gets one shot; stopping after the first batch would leave work
    // sitting until the next cron tick for no reason.
    const h = deps({ claimDueJobs: batching([[job("a"), job("b")], [job("c")]]) });
    const result = await drainDueJobs(h.deps, { batchSize: 2 });
    expect(result.processed).toBe(3);
    expect(result.stoppedEarly).toBe(false);
    expect(h.rescheduled.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("stops at maxJobs and says so", async () => {
    const h = deps({ claimDueJobs: async (limit) => Array.from({ length: limit }, (_, i) => job(`j${i}`)) });
    const result = await drainDueJobs(h.deps, { maxJobs: 4, batchSize: 3 });
    expect(result.processed).toBe(4);
    // The caller needs to know more is waiting; otherwise a backlog drains one batch per minute.
    expect(result.stoppedEarly).toBe(true);
  });

  it("never claims more than the remaining allowance", async () => {
    // Over-claiming leases jobs this invocation will not touch, idling them for the lease window.
    const limits: number[] = [];
    const h = deps({
      claimDueJobs: async (limit) => {
        limits.push(limit);
        return Array.from({ length: limit }, (_, i) => job(`j${limits.length}-${i}`));
      },
    });
    await drainDueJobs(h.deps, { maxJobs: 5, batchSize: 3 });
    expect(limits).toEqual([3, 2]);
  });

  it("stops starting jobs once the time budget is spent", async () => {
    let clock = 0;
    const h = deps({
      claimDueJobs: batching([[job("a"), job("b"), job("c")]]),
      mint: {
        submitReceiveMessage: async () => {
          clock += 30_000;
          return { signature: "sig" };
        },
      },
      now: () => clock,
    });

    const result = await drainDueJobs(h.deps, { budgetMs: 45_000 });
    expect(result.stoppedEarly).toBe(true);
    // Two jobs ran (0ms and 30ms in); the third was past budget.
    expect(h.attempted).toEqual(["a", "b"]);
  });

  it("gives an unprocessed leased job straight back rather than holding its lease", async () => {
    let clock = 0;
    const h = deps({
      claimDueJobs: batching([[job("a"), job("b")]]),
      mint: {
        submitReceiveMessage: async () => {
          clock += 60_000;
          return { signature: "sig" };
        },
      },
      now: () => clock,
    });

    await drainDueJobs(h.deps, { budgetMs: 45_000 });
    // `b` never ran, and must be immediately claimable — not left leased for two minutes.
    expect(h.rescheduled).toContainEqual({ id: "b", decision: { type: "requeue", delayMs: 0 } });
  });

  it("retries with backoff when a job throws, instead of dropping it", async () => {
    // processJob persists before deciding, so a throw means the store or something outside the
    // state machine failed. Losing the job over it would strand a transfer.
    const h = deps({
      claimDueJobs: batching([[job("a")]]),
      store: {
        save: async () => {
          throw new Error("connection terminated unexpectedly");
        },
        get: async () => undefined,
      },
    });

    const result = await drainDueJobs(h.deps);
    expect(result.processed).toBe(1);
    expect(h.rescheduled).toEqual([{ id: "a", decision: { type: "requeue", delayMs: 30_000 } }]);
  });

  it("counts each outcome separately", async () => {
    const h = deps({
      claimDueJobs: batching([[job("done"), job("dead", { status: "failed", attempts: 99 })]]),
    });
    const result = await drainDueJobs(h.deps);
    expect(result).toMatchObject({ processed: 2, completed: 1, deadLettered: 1, requeued: 0 });
  });

  it("logs what it did per job", async () => {
    const log = vi.fn();
    const h = deps({ claimDueJobs: batching([[job("a")]]), log });
    await drainDueJobs(h.deps);
    expect(log).toHaveBeenCalledWith("processed relay job", expect.objectContaining({ jobId: "a" }));
  });
});
