/**
 * A budget for calls to Circle's Iris API, so we know before we call whether we would be rate
 * limited, instead of finding out from a 429.
 *
 * # Why this exists
 *
 * Circle documents a limit of 40 requests per second, and a breach blocks the caller for five
 * minutes (HTTP 429). Every part of this product that reads Iris — the delivery status a user
 * watches after signing, the `/claim` lookup, the fee quote, the health check — shares one source
 * address per deployment, so one busy minute can lock all of them out at once, and the people locked
 * out are exactly the ones waiting on a transfer. The block costs nothing to prevent and five minutes
 * to recover from.
 *
 * # What it is
 *
 * A counter and a block flag, kept as one small record so it can live in a single atomic store
 * (a Convex document in production; memory in tests). `decide` is pure — it takes the record, the
 * time and the number of calls wanted and returns a verdict and the next record — so the same code
 * runs inside the store's transaction and in a unit test with a fake clock.
 *
 * The rate is a sliding estimate over the last second: this second's calls plus the previous second's
 * calls weighted by how much of it is still in the window. That is what stops a burst straddling a
 * second boundary from doubling the limit, which a plain per-second counter allows.
 *
 * The default limit is 30, not 40. The slack covers what this counter cannot see: a second deployment,
 * a preview build, someone running `scripts/burn-verdicts.py` from the same address.
 *
 * # What it does not do
 *
 * It does not protect the transfer. A block on *our* Iris calls stops us reading Iris; it does not
 * touch Circle forwarding a burn. So a block is a reason to show "status unavailable", never a reason
 * to stop a user bridging.
 */

/** Circle's documented ceiling, requests per second. */
export const IRIS_DOCUMENTED_LIMIT_PER_SECOND = 40;
/** How long Circle blocks a caller that breaches it. */
export const IRIS_DOCUMENTED_BLOCK_MS = 5 * 60_000;

export interface BudgetOptions {
  /** Calls per second we allow ourselves. Below Circle's own limit, on purpose. */
  limitPerSecond: number;
  /** How long to stay off Iris after a 429. Circle's five minutes plus a margin. */
  blockMs: number;
}

export const DEFAULT_BUDGET: BudgetOptions = {
  limitPerSecond: 30,
  blockMs: IRIS_DOCUMENTED_BLOCK_MS + 30_000,
};

/** All the state there is. Small enough to be one document. */
export interface BudgetState {
  /** The whole second (`floor(ms / 1000)`) `count` belongs to. */
  second: number;
  count: number;
  /** Calls made in the second before `second`. */
  prevCount: number;
  /** Epoch ms until which we stay off Iris; 0 when not blocked. */
  blockedUntil: number;
}

export const EMPTY_BUDGET_STATE: BudgetState = {
  second: 0,
  count: 0,
  prevCount: 0,
  blockedUntil: 0,
};

export type BlockReason = "blocked" | "over_budget";

export type Decision =
  | { allowed: true; state: BudgetState }
  | { allowed: false; reason: BlockReason; retryAfterMs: number; state: BudgetState };

/** Moves the record forward to `nowMs`'s second, carrying the previous second's count if adjacent. */
function roll(state: BudgetState, nowMs: number): BudgetState {
  const second = Math.floor(nowMs / 1000);
  if (second === state.second) return state;
  if (second === state.second + 1) return { ...state, second, count: 0, prevCount: state.count };
  // Time went backwards (clock skew between instances) or more than a second passed: nothing in the
  // window any more.
  if (second < state.second) return state;
  return { ...state, second, count: 0, prevCount: 0 };
}

/** Calls in the last second: this second's, plus the previous second's share still in the window. */
export function estimatedRate(state: BudgetState, nowMs: number): number {
  const r = roll(state, nowMs);
  const intoSecond = (nowMs % 1000) / 1000;
  return r.count + r.prevCount * (1 - intoSecond);
}

/**
 * Whether `n` calls may be made now, and the record to keep. Pure: refusing changes nothing, so a
 * refused caller costs no budget.
 */
export function decide(
  state: BudgetState,
  nowMs: number,
  n = 1,
  opts: BudgetOptions = DEFAULT_BUDGET,
): Decision {
  if (state.blockedUntil > nowMs) {
    return { allowed: false, reason: "blocked", retryAfterMs: state.blockedUntil - nowMs, state };
  }
  const rolled = roll(state, nowMs);
  if (estimatedRate(rolled, nowMs) + n > opts.limitPerSecond) {
    // The window frees as the second turns over.
    return {
      allowed: false,
      reason: "over_budget",
      retryAfterMs: Math.max(1, 1000 - (nowMs % 1000)),
      state: rolled,
    };
  }
  return { allowed: true, state: { ...rolled, count: rolled.count + n } };
}

/** Circle answered 429: stay off Iris for the block window whatever our own counter says. */
export function markRateLimited(
  state: BudgetState,
  nowMs: number,
  opts: BudgetOptions = DEFAULT_BUDGET,
): BudgetState {
  return { ...roll(state, nowMs), blockedUntil: nowMs + opts.blockMs };
}

export interface BudgetUsage {
  /** Estimated calls in the last second. */
  perSecond: number;
  limitPerSecond: number;
  /** Fraction of the limit in use, 0 to 1. */
  utilisation: number;
  /** Epoch ms we are blocked until, or null. */
  blockedUntil: number | null;
}

export function usage(
  state: BudgetState,
  nowMs: number,
  opts: BudgetOptions = DEFAULT_BUDGET,
): BudgetUsage {
  const perSecond = estimatedRate(state, nowMs);
  return {
    perSecond,
    limitPerSecond: opts.limitPerSecond,
    utilisation: Math.min(1, perSecond / opts.limitPerSecond),
    blockedUntil: state.blockedUntil > nowMs ? state.blockedUntil : null,
  };
}

/**
 * Where the record lives. An implementation must make `acquire` atomic — read, decide and write as
 * one step — or two serverless instances will each see room and together exceed the limit. Convex
 * mutations are serializable, which is why production uses one.
 */
export interface BudgetStore {
  acquire(nowMs: number, n?: number): Promise<Decision>;
  markRateLimited(nowMs: number): Promise<void>;
  usage(nowMs: number): Promise<BudgetUsage>;
  /**
   * Which counter the most recent call actually used: `shared` (the one every instance sees) or
   * `local` (this instance only). Lets a health check tell "counting properly" from "quietly counting
   * alone", which is what a wrong shared secret or an unreachable store turns into.
   */
  backend?(): "shared" | "local";
}

/** In-memory store: for tests and for a single local process. Not shared across instances. */
export function createMemoryBudgetStore(
  opts: BudgetOptions = DEFAULT_BUDGET,
  initial: BudgetState = EMPTY_BUDGET_STATE,
): BudgetStore {
  let state = initial;
  return {
    async acquire(nowMs, n = 1) {
      const d = decide(state, nowMs, n, opts);
      state = d.state;
      return d;
    },
    async markRateLimited(nowMs) {
      state = markRateLimited(state, nowMs, opts);
    },
    async usage(nowMs) {
      return usage(state, nowMs, opts);
    },
    backend: () => "local",
  };
}

/**
 * Uses `primary` (the shared store) and falls back to `fallback` (memory, per instance) when the
 * primary throws.
 *
 * The counter exists to protect Iris, not to gate it. If Convex is unreachable, refusing every Iris
 * call would blind the delivery status and the pre-flight check over a bookkeeping failure, which
 * is a worse outcome than each instance counting alone: one instance's own limit still holds, and
 * the slack under Circle's 40/s absorbs a few of them.
 *
 * `onError` is how a caller finds out the shared store is failing; it must not throw.
 */
export function createResilientBudgetStore(
  primary: BudgetStore,
  fallback: BudgetStore,
  onError: (err: unknown) => void = () => undefined,
): BudgetStore {
  let last: "shared" | "local" = "shared";
  async function guarded<T>(use: (s: BudgetStore) => Promise<T>): Promise<T> {
    try {
      const out = await use(primary);
      last = "shared";
      return out;
    } catch (err) {
      last = "local";
      onError(err);
      return use(fallback);
    }
  }
  return {
    acquire: (nowMs, n) => guarded((s) => s.acquire(nowMs, n)),
    // A 429 has to reach both: the shared record for other instances, the local one for this
    // instance if the shared one is what failed.
    async markRateLimited(nowMs) {
      await fallback.markRateLimited(nowMs);
      try {
        await primary.markRateLimited(nowMs);
      } catch (err) {
        onError(err);
      }
    },
    usage: (nowMs) => guarded((s) => s.usage(nowMs)),
    backend: () => last,
  };
}

/** Thrown instead of calling Iris when the budget says not to, or right after Circle says 429. */
export class IrisUnavailable extends Error {
  constructor(
    public readonly reason: BlockReason | "rate_limited",
    public readonly retryAfterMs: number,
  ) {
    super(
      reason === "over_budget"
        ? `Iris call held back by our own rate budget; retry in ${retryAfterMs}ms`
        : `Iris is rate limiting us (${reason}); not calling it for ${Math.ceil(retryAfterMs / 1000)}s`,
    );
    this.name = "IrisUnavailable";
  }
}

/**
 * A `fetch` that spends budget first and reacts to a 429. Every Iris call from our servers should go
 * through one of these, so the counter sees all of them.
 */
export function createBudgetedFetch(
  store: BudgetStore,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
  blockMs: number = DEFAULT_BUDGET.blockMs,
): typeof fetch {
  return async (input, init) => {
    const verdict = await store.acquire(now());
    if (!verdict.allowed) throw new IrisUnavailable(verdict.reason, verdict.retryAfterMs);
    const res = await fetchImpl(input, init);
    if (res.status === 429) {
      await store.markRateLimited(now());
      throw new IrisUnavailable("rate_limited", blockMs);
    }
    return res;
  };
}
