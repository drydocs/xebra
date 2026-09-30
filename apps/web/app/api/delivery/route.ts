import { type Delivery, IrisUnavailable, readDelivery } from "@xebra/cctp-client";
import { irisBaseUrl, irisFetch, stellarDomainId } from "../../../lib/server/iris";
import { createTtlCache } from "../../../lib/server/ttl-cache";

/**
 * How a burn is getting on, straight from Circle. Polled by the receipt so the pending state
 * resolves instead of spinning.
 *
 * There is no relay to ask. Circle's Forwarding Service mints on the destination, and Iris reports
 * how that went (`forwardState`, `forwardTxHash`), so this is one budgeted lookup by transaction
 * hash, cached for a few seconds because every receipt for the same burn asks the same question.
 *
 * `unknown` means we could not ask — Circle unreachable, or our own rate budget holding us back. It
 * is deliberately not `waiting`: an unanswerable question is not progress, and the page must not
 * imply the transfer is fine or failed on the strength of it.
 *
 * Read-only and public: it answers only about a burn hash the caller already holds.
 */

export const dynamic = "force-dynamic";

const TX_HASH = /^[0-9a-f]{64}$/;

type Answer = { status: "known"; delivery: Delivery } | { status: "unknown"; reason: string };

const cached = createTtlCache<Answer>(5_000);

export async function GET(request: Request): Promise<Response> {
  const tx = new URL(request.url).searchParams.get("tx")?.trim().toLowerCase();
  if (!tx || !TX_HASH.test(tx)) {
    return Response.json({ error: "tx must be a 64-character hex string" }, { status: 400 });
  }

  const answer = await cached(tx, async (): Promise<Answer> => {
    try {
      const res = await irisFetch(
        `${irisBaseUrl()}/v2/messages/${stellarDomainId()}?transactionHash=${tx}`,
        { cache: "no-store", signal: AbortSignal.timeout(6_000) },
      );
      // 404 is "not indexed yet", which is just waiting; anything else that is not OK is a
      // question we could not answer.
      if (res.status === 404) return { status: "known", delivery: readDelivery(null) };
      if (!res.ok) return { status: "unknown", reason: `Circle returned ${res.status}` };
      return { status: "known", delivery: readDelivery(await res.json()) };
    } catch (err) {
      if (err instanceof IrisUnavailable) {
        return { status: "unknown", reason: "status lookups are paused for a moment" };
      }
      return { status: "unknown", reason: "could not reach Circle" };
    }
  });

  return Response.json(
    answer.status === "known" ? { status: "known", ...answer.delivery } : answer,
  );
}
