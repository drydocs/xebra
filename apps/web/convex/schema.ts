import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Convex holds one thing here: the counter that keeps our calls to Circle's Iris API under its
 * rate limit. See `irisBudget.ts`.
 *
 * There used to be relay state in this file — jobs, retry schedules, a burn-watcher cursor. The
 * relay is gone: Circle's Forwarding Service mints on the destination, and a transfer whose
 * forward fails is claimed by its owner at `/claim`. Nothing here holds keys, funds or anyone's
 * transfer, so losing this database costs a few seconds of rate-limit memory and nothing else.
 */

export default defineSchema({
  irisBudget: defineTable({
    /** A single row, addressed by name so a second budget (a different Circle host) needs no
     *  schema change. */
    key: v.string(),
    /** The whole second (`floor(ms / 1000)`) `count` belongs to. */
    second: v.number(),
    count: v.number(),
    /** Calls made in the second before `second`. */
    prevCount: v.number(),
    /** Epoch ms until which we stay off Iris after a 429; 0 when not blocked. */
    blockedUntil: v.number(),
  }).index("by_key", ["key"]),
});
