import {
  authorizeBearer,
  checkBurnAdmission,
  createHorizonBurnClock,
  drainDueJobs,
  isStellarTxHash,
  submitBurn,
} from "@xebra/relay-core";
import { env } from "../../../../lib/env";
import { MissingRelayConfig, isRelayConfigured, relayDeps } from "../../../../lib/relay-runtime";

/**
 * Records a freshly signed burn and starts its mint.
 *
 * # Why the work happens here rather than in a relay service
 *
 * There is no relay service in this deployment. `apps/cctp-relay` is a container and this project
 * deploys to Vercel, so the same pipeline from `@xebra/relay-core` runs inside route handlers:
 * this one on the fast path, and `/api/cron/relay` as the safety net.
 *
 * Draining inline is what makes the product work on either Vercel plan. Cron is once per minute
 * on Pro and **once per day** on Hobby, and a transfer cannot wait a day for its mint — so the
 * mint is attempted in this request, right after the burn is recorded, and cron only picks up what
 * this could not finish.
 *
 * # Why it does not simply mint whatever it is given
 *
 * Every mint costs us 867,621 lamports of permanent rent, and until the wrapper contract is
 * deployed there is nothing on chain distinguishing a burn made through this app from any other
 * CCTP user's burn on Stellar. An unbounded endpoint is therefore a funded drain pointed at
 * strangers' transfers. `checkBurnAdmission` bounds it by recency and a rolling spend cap; see its
 * module comment for what that does and does not achieve.
 *
 * `RELAY_SUBMIT_TOKEN` bypasses those bounds, for operations — re-driving an old burn by hand is
 * exactly what the recency check would otherwise block.
 *
 * # Why a refusal is not a lost transfer
 *
 * The burn is already on chain when this is called. Circle's attestation is public and never
 * expires, so anyone holding it can complete the mint, including the user. Refusing to sponsor
 * costs the caller gas, not funds.
 */

export const dynamic = "force-dynamic";
/** Long enough to record the burn and usually mint it in the same request, without approaching
 *  Hobby's 300s ceiling — a request that hangs that long looks broken to the person waiting. */
export const maxDuration = 60;

export async function POST(request: Request): Promise<Response> {
  if (!isRelayConfigured()) {
    // Not a 500: a deployment without a relay is a valid state — the bridge works, users just pay
    // their own mint gas — and a 500 would read to the UI as the transfer having broken.
    return Response.json(
      { status: "unavailable", reason: "no relay is configured for this deployment" },
      { status: 503 },
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const txHash =
    typeof body === "object" && body !== null
      ? (body as Record<string, unknown>).txHash
      : undefined;

  if (!isStellarTxHash(txHash)) {
    return Response.json({ error: "txHash must be a 64-character hex string" }, { status: 400 });
  }

  try {
    const deps = relayDeps();

    const opsToken = process.env.RELAY_SUBMIT_TOKEN;
    const privileged = Boolean(
      opsToken && authorizeBearer(request.headers.get("authorization"), opsToken),
    );

    if (!privileged) {
      const verdict = await checkBurnAdmission(
        {
          burnClosedAt: createHorizonBurnClock(env.horizonUrl),
          countSponsoredSince: (since) => deps.store.countSponsoredSince(since),
        },
        txHash,
      );
      if (!verdict.admit) {
        return Response.json({ status: "unavailable", reason: verdict.reason }, { status: 503 });
      }
    }

    const { job, created } = await submitBurn(deps.watcher, txHash);

    // Drive it as far as it will go now. A shorter budget than the cron tick's, because someone
    // is waiting on this response — an attestation that is not ready yet is left to cron rather
    // than held open.
    const drained = await drainDueJobs(deps.drain, { maxJobs: 3, budgetMs: 25_000 });

    return Response.json(
      { status: "queued", jobId: job.id, created, drained },
      { status: created ? 201 : 200 },
    );
  } catch (err) {
    if (err instanceof MissingRelayConfig) {
      return Response.json({ status: "unavailable", reason: err.message }, { status: 503 });
    }
    // Never echo the internal error: it can carry a connection string.
    console.error("[relay] burn submission failed", err);
    return Response.json({ status: "unavailable", reason: "could not queue the burn" }, { status: 503 });
  }
}
