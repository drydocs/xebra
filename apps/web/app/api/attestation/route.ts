import { env } from "../../../lib/env";

/**
 * Circle's attested `(message, attestation)` pair for a burn.
 *
 * This is what makes a transfer claimable by anyone. Circle attests a burn and publishes the
 * signed pair; whoever holds it can submit `receiveMessage` on Solana and complete the mint. The
 * relay is a convenience that does this for you and pays the gas — it is not custody, and this
 * route is what lets the `/claim` page prove it.
 *
 * # Why it is proxied rather than called from the browser
 *
 * Only so the Iris base URL stays a single server-side value. Iris itself permits browser
 * origins, unlike Solana's RPC. Making it a `NEXT_PUBLIC_*` would mean a build-time constant
 * baked into the bundle and one more variable that has to be right before the build — and
 * pointing at Circle's sandbox by mistake leaves every burn "pending" forever rather than failing
 * loudly.
 *
 * Nothing here is secret. The response is public data about a public transaction.
 */

export const dynamic = "force-dynamic";

const TX_HASH = /^[0-9a-f]{64}$/;

export async function GET(request: Request): Promise<Response> {
  const tx = new URL(request.url).searchParams.get("tx")?.trim().toLowerCase();
  if (!tx || !TX_HASH.test(tx)) {
    return Response.json({ error: "tx must be a 64-character hex string" }, { status: 400 });
  }

  const base = process.env.IRIS_BASE_URL ?? "https://iris-api.circle.com";
  const domain = process.env.STELLAR_CCTP_DOMAIN_ID ?? "27";

  try {
    const res = await fetch(`${base}/v2/messages/${domain}?transactionHash=${tx}`, {
      cache: "no-store",
    });

    // Iris answers 404 for a transaction it has not indexed. That is "not yet", not an error:
    // a burn is queryable within seconds but a caller may simply be early.
    if (res.status === 404) {
      return Response.json({ status: "unknown", reason: "Circle has not indexed this burn yet" });
    }
    if (!res.ok) {
      return Response.json(
        { status: "unknown", reason: `Circle returned ${res.status}` },
        { status: 502 },
      );
    }

    const body = (await res.json()) as {
      messages?: Array<{
        message: string;
        attestation: string | null;
        status: string;
        eventNonce?: string;
      }>;
    };

    const first = body.messages?.[0];
    if (!first) {
      return Response.json({ status: "unknown", reason: "no CCTP message in that transaction" });
    }
    if (first.status !== "complete" || !first.attestation) {
      // Circle signs within a couple of minutes for a fast transfer. Reported separately from
      // "unknown" because waiting is the right response and retrying a different hash is not.
      return Response.json({ status: "pending" });
    }

    return Response.json({
      status: "complete",
      message: first.message,
      attestation: first.attestation,
      // Solana's USDC mint, so the page can check the recipient token account without another
      // build-time constant of its own.
      usdcMint: env.usdcSolanaMint,
      sourceDomainId: Number(domain),
    });
  } catch (err) {
    return Response.json(
      { status: "unknown", reason: err instanceof Error ? err.message : "request failed" },
      { status: 502 },
    );
  }
}
