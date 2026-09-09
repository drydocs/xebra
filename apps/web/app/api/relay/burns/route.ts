import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

/**
 * Hands a freshly signed burn to the relay.
 *
 * # Why this is a proxy and not the relay itself
 *
 * The relay lives in Convex (`apps/web/convex/`), because it needs to keep working between
 * requests: an attestation can take a minute, a Solana submission can fail and need retrying, and
 * a Vercel function is killed the moment it returns. Convex's scheduler runs every minute on the
 * free plan; Vercel Cron runs once per *day* on Hobby.
 *
 * The browser could call Convex directly. It goes through here so the page keeps talking to its
 * own origin — no second client, no `NEXT_PUBLIC_CONVEX_URL` baked into the bundle for a call the
 * server can make — and so `RELAY_SUBMIT_TOKEN` has somewhere to live that is not the browser.
 *
 * # Why the function is named as a string
 *
 * `makeFunctionReference` instead of Convex's generated `api` object: `convex/_generated/` is
 * written by `npx convex dev` against a developer's own deployment, and it is not in the repo.
 * Importing it here would make the Next.js build fail for anyone who has not run codegen. The
 * name is checked at runtime by Convex, and there is exactly one public function to get wrong.
 *
 * # A failure here is not a lost transfer
 *
 * The burn is already on chain when this is called. Circle's attestation is public and never
 * expires, so anyone holding it can complete the mint, including the user. Failing to reach the
 * relay costs the caller gas, not funds.
 */

export const dynamic = "force-dynamic";
/** Long enough for Convex to mint inline in most cases, short enough that a hung upstream does
 *  not leave someone staring at a spinner. */
export const maxDuration = 60;

const submitBurn = makeFunctionReference<"action">("relay:submitBurn");

const TX_HASH = /^[0-9a-f]{64}$/;

type RelayResult =
  | { status: "queued"; jobId: string; created: boolean }
  | { status: "unavailable" | "rejected"; reason: string };

export async function POST(request: Request): Promise<Response> {
  const convexUrl = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) {
    // Not a 500: a deployment without a relay is a valid state — the bridge works, users just pay
    // their own mint gas — and a 500 would read to the UI as the transfer itself having broken.
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

  if (typeof txHash !== "string" || !TX_HASH.test(txHash)) {
    return Response.json({ error: "txHash must be a 64-character hex string" }, { status: 400 });
  }

  try {
    const client = new ConvexHttpClient(convexUrl);
    const opsToken = process.env.RELAY_SUBMIT_TOKEN;
    const result = (await client.action(submitBurn, {
      txHash,
      ...(opsToken ? { opsToken } : {}),
    })) as RelayResult;

    if (result.status !== "queued") {
      return Response.json({ status: "unavailable", reason: result.reason }, { status: 503 });
    }
    return Response.json(result, { status: result.created ? 201 : 200 });
  } catch (err) {
    // Never echo the upstream error: it can carry a deployment URL or a stack from inside the
    // action.
    console.error("[relay] burn submission failed", err);
    return Response.json(
      { status: "unavailable", reason: "could not reach the relay" },
      { status: 503 },
    );
  }
}
