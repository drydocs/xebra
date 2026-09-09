import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

/**
 * The relay's heartbeat.
 *
 * Every minute, and on the free plan — which is the reason relay state lives in Convex at all.
 * Vercel Cron is once per *day* on Hobby, and a transfer cannot wait a day for a mint to be
 * retried.
 *
 * This is the safety net, not the fast path: `relay.submitBurn` mints inline when the browser
 * reports a burn, so a healthy transfer never waits for a tick. The tick exists for what that
 * could not finish.
 */
const crons = cronJobs();

crons.interval("relay tick", { minutes: 1 }, internal.relay.tick, {});

/**
 * The hot wallet drains by design — every mint burns 867,621 lamports of rent that nobody ever
 * gets back — and when it empties, every transfer stalls silently. Fifteen minutes is frequent
 * enough to catch it long before that, and the thresholds leave days of notice at any plausible
 * early volume.
 */
crons.interval("relay balance check", { minutes: 15 }, internal.relay.checkBalance, {});

export default crons;
