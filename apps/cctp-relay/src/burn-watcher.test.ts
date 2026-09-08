import { describe, expect, it } from "vitest";
import type { RelayJobState } from "@xebra/cctp-client";
import { scanForBurns, submitBurn, type BurnWatcherDeps } from "./burn-watcher.js";

/**
 * A store with the same idempotency contract as Postgres: the natural key is
 * `(sourceDomainId, sourceTxHash)`, and a second insert for the same burn returns the existing
 * job rather than creating another. Duplicate suppression is the whole point of the watcher —
 * without it a re-scanned ledger queues a second mint, which the chain rejects only after
 * charging a fee.
 */
function fakeStore() {
  const byNaturalKey = new Map<string, RelayJobState>();
  return {
    rows: byNaturalKey,
    async upsertBySourceTx(job: RelayJobState) {
      const key = `${job.sourceDomainId}:${job.sourceTxHash}`;
      const existing = byNaturalKey.get(key);
      if (existing) return { job: existing, created: false };
      byNaturalKey.set(key, job);
      return { job, created: true };
    },
  };
}

function deps(overrides: Partial<BurnWatcherDeps> = {}) {
  const store = fakeStore();
  const enqueued: RelayJobState[] = [];
  let cursor: string | undefined;
  let n = 0;

  const base: BurnWatcherDeps = {
    readBurnEvents: async () => ({ events: [], nextCursor: undefined }),
    upsertBySourceTx: store.upsertBySourceTx,
    enqueue: async (job) => {
      enqueued.push(job);
    },
    loadCursor: async () => cursor,
    saveCursor: async (l) => {
      cursor = l;
    },
    sourceDomainId: 27,
    newJobId: () => `job-${++n}`,
    now: () => 1_000,
    ...overrides,
  };
  return { deps: base, enqueued, store, getCursor: () => cursor };
}

describe("scanForBurns", () => {
  it("queues one job per burn and advances the cursor", async () => {
    const h = deps({
      readBurnEvents: async () => ({
        events: [{ txHash: "aaa" }, { txHash: "bbb" }],
        nextCursor: "c-11",
      }),
    });

    const result = await scanForBurns(h.deps);
    expect(result).toEqual({ cursor: "c-11", queued: 2, duplicates: 0 });
    expect(h.enqueued.map((j) => j.sourceTxHash)).toEqual(["aaa", "bbb"]);
    expect(h.getCursor()).toBe("c-11");
  });

  it("does not re-queue a burn on a re-scan", async () => {
    // Soroban event cursors overlap on restart; a crash mid-batch re-reads the same ledgers.
    const events = [{ txHash: "aaa" }];
    const h = deps({ readBurnEvents: async () => ({ events, nextCursor: "c-10" }) });

    const first = await scanForBurns(h.deps);
    const second = await scanForBurns(h.deps);

    expect(first.queued).toBe(1);
    expect(second.queued).toBe(0);
    expect(second.duplicates).toBe(1);
    // The important assertion: exactly one mint is ever attempted.
    expect(h.enqueued).toHaveLength(1);
  });

  it("enqueues only after the row is durable", async () => {
    // If enqueue ran first, a crash between enqueue and insert would leave a queue entry with
    // no state behind it — the exact failure the Postgres store exists to prevent.
    const order: string[] = [];
    const h = deps({
      readBurnEvents: async () => ({ events: [{ txHash: "aaa" }], nextCursor: "c-5" }),
      upsertBySourceTx: async (job) => {
        order.push("persist");
        return { job, created: true };
      },
      enqueue: async () => {
        order.push("enqueue");
      },
    });

    await scanForBurns(h.deps);
    expect(order).toEqual(["persist", "enqueue"]);
  });

  it("advances the cursor only after the batch is processed", async () => {
    // Re-scanning a ledger is free; skipping one strands a transfer.
    const order: string[] = [];
    const h = deps({
      readBurnEvents: async () => ({ events: [{ txHash: "aaa" }], nextCursor: "c-7" }),
      enqueue: async () => {
        order.push("enqueue");
      },
      saveCursor: async () => {
        order.push("saveCursor");
      },
    });

    await scanForBurns(h.deps);
    expect(order).toEqual(["enqueue", "saveCursor"]);
  });

  it("resumes from the saved cursor rather than rescanning from zero", async () => {
    let requestedFrom: string | undefined;
    const h = deps({
      loadCursor: async () => "c-500",
      readBurnEvents: async (from) => {
        requestedFrom = from;
        return { events: [], nextCursor: "c-500" };
      },
    });
    await scanForBurns(h.deps);
    expect(requestedFrom).toBe("c-500");
  });

  it("handles an empty batch without side effects", async () => {
    const h = deps();
    const result = await scanForBurns(h.deps);
    expect(result.queued).toBe(0);
    expect(h.enqueued).toHaveLength(0);
  });
});

describe("submitBurn", () => {
  it("queues a burn supplied by hash, for direct-mode transfers", async () => {
    // Direct-mode burns go straight through Circle's contract and carry nothing on chain that
    // marks them as ours, so the frontend hands us the hash instead.
    const h = deps();
    const result = await submitBurn(h.deps, "ca70f32e");
    expect(result.created).toBe(true);
    expect(h.enqueued).toHaveLength(1);
    expect(h.enqueued[0]?.sourceTxHash).toBe("ca70f32e");
  });

  it("is idempotent when the same hash is submitted twice", async () => {
    const h = deps();
    await submitBurn(h.deps, "ca70f32e");
    const second = await submitBurn(h.deps, "ca70f32e");
    expect(second.created).toBe(false);
    expect(h.enqueued).toHaveLength(1);
  });
});
