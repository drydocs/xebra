import { describe, expect, it, vi } from "vitest";
import {
  type BudgetStore,
  DEFAULT_BUDGET,
  EMPTY_BUDGET_STATE,
  IrisUnavailable,
  createBudgetedFetch,
  createMemoryBudgetStore,
  createResilientBudgetStore,
  decide,
  estimatedRate,
  markRateLimited,
  usage,
} from "./iris-budget.js";

const OPTS = { limitPerSecond: 30, blockMs: 330_000 };
const T0 = 1_800_000_000_000; // a whole second, so offsets inside it are exact

/** Spends `count` calls at `nowMs`, one at a time, returning how many were allowed. */
function spend(state: typeof EMPTY_BUDGET_STATE, nowMs: number, count: number) {
  let s = state;
  let allowed = 0;
  for (let i = 0; i < count; i++) {
    const d = decide(s, nowMs, 1, OPTS);
    s = d.state;
    if (d.allowed) allowed++;
  }
  return { state: s, allowed };
}

describe("decide", () => {
  it("allows exactly the limit within one second and refuses the rest", () => {
    const { allowed, state } = spend(EMPTY_BUDGET_STATE, T0, 50);
    expect(allowed).toBe(30);
    const next = decide(state, T0, 1, OPTS);
    expect(next.allowed).toBe(false);
    if (!next.allowed) expect(next.reason).toBe("over_budget");
  });

  it("frees the window as the second turns over", () => {
    const filled = spend(EMPTY_BUDGET_STATE, T0, 30).state;
    // Two whole seconds later nothing from before counts.
    expect(decide(filled, T0 + 2_000, 1, OPTS).allowed).toBe(true);
  });

  it("does not let a burst straddling a second boundary double the limit", () => {
    // 30 calls at the very end of one second, then 30 more at the very start of the next. A plain
    // per-second counter would allow all 60; Circle would see 60 in about a millisecond.
    const end = spend(EMPTY_BUDGET_STATE, T0 + 999, 30);
    expect(end.allowed).toBe(30);
    const start = spend(end.state, T0 + 1_000, 30);
    expect(start.allowed).toBeLessThan(5);
  });

  it("weights the previous second by how much of it is still in the window", () => {
    const s = spend(EMPTY_BUDGET_STATE, T0, 30).state;
    // Half a second into the next second, about half of the previous second's calls still count.
    const rate = estimatedRate(s, T0 + 1_500);
    expect(rate).toBeCloseTo(15, 5);
    const half = spend(s, T0 + 1_500, 30);
    expect(half.allowed).toBeGreaterThanOrEqual(14);
    expect(half.allowed).toBeLessThanOrEqual(16);
  });

  it("charges nothing for a refused call", () => {
    const full = spend(EMPTY_BUDGET_STATE, T0, 30).state;
    const refused = decide(full, T0, 1, OPTS);
    expect(refused.allowed).toBe(false);
    expect(refused.state.count).toBe(full.count);
  });

  it("can take several calls at once, or none of them", () => {
    const ok = decide(EMPTY_BUDGET_STATE, T0, 30, OPTS);
    expect(ok.allowed).toBe(true);
    expect(decide(EMPTY_BUDGET_STATE, T0, 31, OPTS).allowed).toBe(false);
  });

  it("tells a refused caller how long until the window frees", () => {
    const full = spend(EMPTY_BUDGET_STATE, T0 + 250, 30).state;
    const d = decide(full, T0 + 250, 1, OPTS);
    expect(d.allowed).toBe(false);
    if (!d.allowed) expect(d.retryAfterMs).toBe(750);
  });

  it("ignores a clock that appears to run backwards rather than corrupting the count", () => {
    const s = spend(EMPTY_BUDGET_STATE, T0 + 5_000, 10).state;
    const d = decide(s, T0, 1, OPTS); // an instance whose clock is 5s behind
    expect(d.allowed).toBe(true);
    expect(d.state.count).toBe(11);
  });
});

describe("blocking after a 429", () => {
  it("refuses everything for the block window regardless of the counter", () => {
    const blocked = markRateLimited(EMPTY_BUDGET_STATE, T0, OPTS);
    expect(blocked.blockedUntil).toBe(T0 + 330_000);
    const d = decide(blocked, T0 + 60_000, 1, OPTS);
    expect(d.allowed).toBe(false);
    if (!d.allowed) {
      expect(d.reason).toBe("blocked");
      expect(d.retryAfterMs).toBe(270_000);
    }
  });

  it("allows calls again once the block has passed", () => {
    const blocked = markRateLimited(EMPTY_BUDGET_STATE, T0, OPTS);
    expect(decide(blocked, T0 + 330_001, 1, OPTS).allowed).toBe(true);
  });

  it("stays off Iris for longer than Circle's own five minutes", () => {
    expect(DEFAULT_BUDGET.blockMs).toBeGreaterThan(5 * 60_000);
    expect(DEFAULT_BUDGET.limitPerSecond).toBeLessThan(40);
  });
});

describe("usage", () => {
  it("reports how full the window is and whether we are blocked", () => {
    const s = spend(EMPTY_BUDGET_STATE, T0, 15).state;
    const u = usage(s, T0, OPTS);
    expect(u.perSecond).toBe(15);
    expect(u.utilisation).toBe(0.5);
    expect(u.blockedUntil).toBeNull();
    const b = usage(markRateLimited(s, T0, OPTS), T0 + 1, OPTS);
    expect(b.blockedUntil).toBe(T0 + 330_000);
  });
});

describe("the store", () => {
  it("serialises acquires so concurrent callers cannot together exceed the limit", async () => {
    const store = createMemoryBudgetStore(OPTS);
    const results = await Promise.all(Array.from({ length: 100 }, () => store.acquire(T0)));
    expect(results.filter((r) => r.allowed)).toHaveLength(30);
  });
});

describe("createBudgetedFetch", () => {
  const ok = () => new Response("{}", { status: 200 });

  it("spends budget, calls through, and returns Circle's response", async () => {
    const store = createMemoryBudgetStore(OPTS);
    const inner = vi.fn(async () => ok());
    const f = createBudgetedFetch(store, inner as unknown as typeof fetch, () => T0);
    const res = await f("https://iris.example/x");
    expect(res.status).toBe(200);
    expect(inner).toHaveBeenCalledTimes(1);
    expect((await store.usage(T0)).perSecond).toBe(1);
  });

  it("does not call Iris at all once over budget", async () => {
    const store = createMemoryBudgetStore({ limitPerSecond: 2, blockMs: 1000 });
    const inner = vi.fn(async () => ok());
    const f = createBudgetedFetch(store, inner as unknown as typeof fetch, () => T0);
    await f("a");
    await f("b");
    await expect(f("c")).rejects.toMatchObject({ name: "IrisUnavailable", reason: "over_budget" });
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("goes quiet for the whole block window after Circle answers 429", async () => {
    const store = createMemoryBudgetStore(OPTS);
    let t = T0;
    const inner = vi.fn(async () => new Response("slow down", { status: 429 }));
    const f = createBudgetedFetch(store, inner as unknown as typeof fetch, () => t, OPTS.blockMs);

    await expect(f("a")).rejects.toBeInstanceOf(IrisUnavailable);
    expect(inner).toHaveBeenCalledTimes(1);

    // Every later call is refused locally, without touching Circle, until the window passes.
    t = T0 + 120_000;
    await expect(f("b")).rejects.toMatchObject({ reason: "blocked" });
    expect(inner).toHaveBeenCalledTimes(1);

    t = T0 + 330_001;
    inner.mockImplementation(async () => ok());
    expect((await f("c")).status).toBe(200);
  });

  it("passes other error statuses through for the caller to interpret", async () => {
    const store = createMemoryBudgetStore(OPTS);
    const inner = vi.fn(async () => new Response("no", { status: 404 }));
    const f = createBudgetedFetch(store, inner as unknown as typeof fetch, () => T0);
    expect((await f("a")).status).toBe(404);
    // A 404 ("Message not found") is not a rate limit and must not start a block.
    expect((await store.usage(T0)).blockedUntil).toBeNull();
  });
});

describe("createResilientBudgetStore", () => {
  const broken = (): BudgetStore => ({
    acquire: async () => {
      throw new Error("convex down");
    },
    markRateLimited: async () => {
      throw new Error("convex down");
    },
    usage: async () => {
      throw new Error("convex down");
    },
  });

  it("uses the primary while it works", async () => {
    const primary = createMemoryBudgetStore(OPTS);
    const fallback = createMemoryBudgetStore(OPTS);
    const store = createResilientBudgetStore(primary, fallback);
    await store.acquire(T0);
    expect((await primary.usage(T0)).perSecond).toBe(1);
    expect((await fallback.usage(T0)).perSecond).toBe(0);
  });

  it("keeps counting locally, and reports the failure, when the primary throws", async () => {
    const errors: unknown[] = [];
    const store = createResilientBudgetStore(broken(), createMemoryBudgetStore(OPTS), (e) =>
      errors.push(e),
    );
    const results = await Promise.all(Array.from({ length: 40 }, () => store.acquire(T0)));
    // Still limited, just per instance.
    expect(results.filter((r) => r.allowed)).toHaveLength(30);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("records a 429 locally even when the shared store cannot take it", async () => {
    const fallback = createMemoryBudgetStore(OPTS);
    const store = createResilientBudgetStore(broken(), fallback);
    await expect(store.markRateLimited(T0)).resolves.toBeUndefined();
    expect((await fallback.usage(T0 + 1)).blockedUntil).toBe(T0 + 330_000);
    expect((await store.acquire(T0 + 1)).allowed).toBe(false);
  });

  it("records a 429 in the shared store too, so other instances stop", async () => {
    const primary = createMemoryBudgetStore(OPTS);
    const store = createResilientBudgetStore(primary, createMemoryBudgetStore(OPTS));
    await store.markRateLimited(T0);
    expect((await primary.usage(T0 + 1)).blockedUntil).toBe(T0 + 330_000);
  });

  it("reports which counter it used, so a silent fallback is visible", async () => {
    const good = createResilientBudgetStore(
      createMemoryBudgetStore(OPTS),
      createMemoryBudgetStore(OPTS),
    );
    await good.acquire(T0);
    expect(good.backend?.()).toBe("shared");

    const bad = createResilientBudgetStore(broken(), createMemoryBudgetStore(OPTS));
    await bad.acquire(T0);
    expect(bad.backend?.()).toBe("local");
  });

  it("goes back to shared once the primary recovers", async () => {
    let up = false;
    const flaky: BudgetStore = {
      acquire: async () => {
        if (!up) throw new Error("down");
        return { allowed: true, state: EMPTY_BUDGET_STATE };
      },
      markRateLimited: async () => undefined,
      usage: async () => usage(EMPTY_BUDGET_STATE, T0, OPTS),
    };
    const store = createResilientBudgetStore(flaky, createMemoryBudgetStore(OPTS));
    await store.acquire(T0);
    expect(store.backend?.()).toBe("local");
    up = true;
    await store.acquire(T0);
    expect(store.backend?.()).toBe("shared");
  });
});
