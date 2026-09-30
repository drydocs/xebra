import {
  type BudgetState,
  DEFAULT_BUDGET,
  EMPTY_BUDGET_STATE,
  decide,
  markRateLimited,
  usage,
} from "@xebra/cctp-client";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";
import { type MutationCtx, type QueryCtx, mutation, query } from "./_generated/server";

/**
 * The shared counter behind every call our servers make to Circle's Iris API.
 *
 * Vercel runs many short-lived instances and they all reach Iris from the same few addresses, so a
 * counter in one instance's memory sees a fraction of the traffic. A Convex mutation is
 * serializable, which makes read-decide-write a single atomic step: two instances asking at the
 * same instant cannot both be told there is room for the last call.
 *
 * All the arithmetic is `decide` from `@xebra/cctp-client`, the same pure function its unit tests
 * drive with a fake clock. This file only stores the record.
 *
 * # Why these are guarded by a secret
 *
 * They are public functions, because the Next.js server reaches them over HTTP. Unguarded, anyone
 * could call `rateLimited` and have us stop reading Iris for five and a half minutes, or spend the
 * budget with `acquire`. Neither moves money, but both would blind the delivery status and the
 * pre-flight check. The secret is `IRIS_BUDGET_SECRET`, set on this deployment and in the web app's
 * server environment; it never reaches a browser.
 */

const KEY = "iris";

function guard(secret: string): void {
  const expected = process.env.IRIS_BUDGET_SECRET;
  // Refuse when unset rather than accepting everything: a missing variable must not open the door.
  if (!expected || secret !== expected) throw new Error("not authorised");
}

async function load(
  ctx: QueryCtx | MutationCtx,
): Promise<{ id: Id<"irisBudget">; state: BudgetState } | null> {
  const doc = await ctx.db
    .query("irisBudget")
    .withIndex("by_key", (q) => q.eq("key", KEY))
    .unique();
  if (!doc) return null;
  return {
    id: doc._id,
    state: {
      second: doc.second,
      count: doc.count,
      prevCount: doc.prevCount,
      blockedUntil: doc.blockedUntil,
    },
  };
}

async function save(
  ctx: MutationCtx,
  row: { id: Id<"irisBudget"> } | null,
  state: BudgetState,
): Promise<void> {
  if (row) await ctx.db.patch("irisBudget", row.id, state);
  else await ctx.db.insert("irisBudget", { key: KEY, ...state });
}

export const acquire = mutation({
  args: { secret: v.string(), nowMs: v.number(), n: v.optional(v.number()) },
  handler: async (ctx, { secret, nowMs, n }) => {
    guard(secret);
    const row = await load(ctx);
    const d = decide(row?.state ?? EMPTY_BUDGET_STATE, nowMs, n ?? 1, DEFAULT_BUDGET);
    // Written either way: a refusal still rolls the window forward.
    await save(ctx, row, d.state);
    return d.allowed
      ? { allowed: true as const }
      : { allowed: false as const, reason: d.reason, retryAfterMs: d.retryAfterMs };
  },
});

export const rateLimited = mutation({
  args: { secret: v.string(), nowMs: v.number() },
  handler: async (ctx, { secret, nowMs }) => {
    guard(secret);
    const row = await load(ctx);
    await save(ctx, row, markRateLimited(row?.state ?? EMPTY_BUDGET_STATE, nowMs, DEFAULT_BUDGET));
  },
});

export const current = query({
  args: { secret: v.string(), nowMs: v.number() },
  handler: async (ctx, { secret, nowMs }) => {
    guard(secret);
    const row = await load(ctx);
    return usage(row?.state ?? EMPTY_BUDGET_STATE, nowMs, DEFAULT_BUDGET);
  },
});
