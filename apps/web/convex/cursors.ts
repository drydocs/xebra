import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";

/** The burn watcher's place in Soroban's event stream. One row, addressed by name so a second
 *  watcher needs no schema change. */

export const load = internalQuery({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const doc = await ctx.db
      .query("watcherCursors")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    // An empty string is not a usable cursor — `getEvents` rejects it, and treating it as present
    // would suppress the start-ledger bootstrap. Absent and empty mean the same thing.
    return doc?.cursor ? doc.cursor : null;
  },
});

export const save = internalMutation({
  args: { name: v.string(), cursor: v.string() },
  handler: async (ctx, { name, cursor }) => {
    const doc = await ctx.db
      .query("watcherCursors")
      .withIndex("by_name", (q) => q.eq("name", name))
      .unique();
    if (doc) await ctx.db.patch(doc._id, { cursor });
    else await ctx.db.insert("watcherCursors", { name, cursor });
  },
});
