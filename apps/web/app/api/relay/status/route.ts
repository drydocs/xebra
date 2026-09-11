import { ConvexHttpClient } from "convex/browser";
import { makeFunctionReference } from "convex/server";

/**
 * How a burn is getting on. Polled by the receipt so the pending state resolves rather than
 * spinning forever.
 *
 * Read-only and safe to be public: it answers only about a burn hash the caller already holds.
 */

export const dynamic = "force-dynamic";

const statusByBurn = makeFunctionReference<"query">("jobs:statusByBurn");
const TX_HASH = /^[0-9a-f]{64}$/;

export async function GET(request: Request): Promise<Response> {
  const tx = new URL(request.url).searchParams.get("tx")?.trim().toLowerCase();
  if (!tx || !TX_HASH.test(tx)) {
    return Response.json({ error: "tx must be a 64-character hex string" }, { status: 400 });
  }

  const convexUrl = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!convexUrl) return Response.json({ status: "unknown" });

  try {
    const job = (await new ConvexHttpClient(convexUrl).query(statusByBurn, {
      sourceDomainId: Number(process.env.STELLAR_CCTP_DOMAIN_ID ?? "27"),
      sourceTxHash: tx,
    })) as { status: string; destTxSignature: string | null } | null;

    // No row yet is "not seen": the watcher runs about once a minute, so a burn seconds old is
    // normally absent. Distinct from "unknown", which means we could not ask.
    if (!job) return Response.json({ status: "pending" });
    if (job.status === "submitted" || job.status === "confirmed") {
      return Response.json({ status: "minted", signature: job.destTxSignature });
    }
    return Response.json({ status: "pending" });
  } catch {
    return Response.json({ status: "unknown" });
  }
}
