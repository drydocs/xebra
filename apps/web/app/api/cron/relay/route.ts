import { drainDueJobs, scanForBurns } from "@xebra/relay-core";
import { MissingRelayConfig, isRelayConfigured, relayDeps } from "../../../../lib/relay-runtime";

/**
 * The relay's heartbeat. Invoked by Vercel Cron (see `vercel.json`), and safe to invoke by hand.
 *
 * # What replaced the worker process
 *
 * There is no long-running relay in this deployment. Each invocation scans for new burns, then
 * drains whatever jobs are due — the same `processJob` the BullMQ worker calls, with
 * `next_attempt_at` standing in for a Redis delay.
 *
 * # Why this is not the primary path
 *
 * Cron granularity is a plan feature: once per minute on Pro, **once per day** on Hobby. A daily
 * heartbeat would mean a transfer waits up to a day for its mint, which is not a product. So the
 * fast path is inline — `/api/relay/burns` drains right after it records a burn — and this route
 * is the safety net that catches anything the inline drain did not finish: a function killed at
 * its duration limit, an attestation that was not ready yet, a Solana submission that failed and
 * is backing off.
 *
 * That split is why the relay works on either plan, and why upgrading to Pro tightens the worst
 * case rather than enabling the feature.
 *
 * # Authentication
 *
 * Vercel sends `Authorization: Bearer $CRON_SECRET` when that variable is set. Without it the
 * route is world-invocable: not a funds risk — it can only advance jobs that already exist — but
 * it does let anyone burn our function minutes and Iris rate limit, so an unset secret is
 * refused rather than defaulted to open.
 */

export const dynamic = "force-dynamic";
/** Well inside Hobby's 300s ceiling, and it leaves the drain's own 45s budget room to return a
 *  response rather than being killed mid-job. */
export const maxDuration = 60;

export async function GET(request: Request): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    return Response.json(
      { error: "CRON_SECRET is not set; refusing to run an unauthenticated relay tick" },
      { status: 503 },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!isRelayConfigured()) {
    return Response.json({ status: "unconfigured" }, { status: 503 });
  }

  try {
    const deps = relayDeps();

    // Scanned before draining, so a burn found now is minted in this same invocation rather than
    // waiting for the next tick.
    let scan: Awaited<ReturnType<typeof scanForBurns>> | null = null;
    if (deps.hasWatcher) {
      try {
        scan = await scanForBurns(deps.watcher);
      } catch (err) {
        // A failed scan must not stop the drain: jobs already recorded are unrelated to it, and
        // the cursor only advances after a batch is durable, so nothing is skipped by retrying
        // next tick.
        console.error("[relay] burn scan failed", err);
      }
    }

    const drained = await drainDueJobs(deps.drain, { budgetMs: 45_000 });
    return Response.json({ status: "ok", scan, drained });
  } catch (err) {
    if (err instanceof MissingRelayConfig) {
      return Response.json({ status: "unconfigured", reason: err.message }, { status: 503 });
    }
    console.error("[relay] cron tick failed", err);
    return Response.json({ error: "relay tick failed" }, { status: 500 });
  }
}
