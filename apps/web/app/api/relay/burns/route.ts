/**
 * Hands a freshly signed burn to the relay so it sponsors the Solana mint.
 *
 * # Why the browser does not call the relay directly
 *
 * The relay's `POST /burns` is authenticated with a shared secret, because every mint it
 * performs costs it 867,621 lamports of permanent rent and it has no way to tell one burn
 * transaction from another on chain. That secret must never reach a browser, so the call is
 * proxied here, where `RELAY_SUBMIT_TOKEN` is ordinary server-side env — not `NEXT_PUBLIC_*`,
 * and therefore never inlined into the client bundle.
 *
 * # Why a failure here is not a lost transfer
 *
 * By the time this route is called the burn is already on chain and irreversible. The relay is
 * a gas-sponsorship convenience, not custody: the attested `(message, attestation)` pair is
 * public on Circle's Iris API and *anyone* can submit `receiveMessage` to complete the mint,
 * including the user, from `/recover`. So this route reports failure plainly rather than
 * retrying forever, and the UI points at the self-serve path.
 */

export const dynamic = "force-dynamic";

const TX_HASH = /^[0-9a-f]{64}$/;

export async function POST(request: Request): Promise<Response> {
  const relayUrl = process.env.RELAY_URL;
  const token = process.env.RELAY_SUBMIT_TOKEN;

  if (!relayUrl || !token) {
    // Deliberately not a 500: an unconfigured relay is an expected deployment state (the app
    // works without one, users just pay their own mint gas), and a 500 would read to the UI as
    // "something broke with your transfer".
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
    const res = await fetch(new URL("/burns", relayUrl), {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ txHash }),
      cache: "no-store",
    });

    if (!res.ok) {
      return Response.json(
        { status: "unavailable", reason: `relay returned ${res.status}` },
        { status: 503 },
      );
    }

    const result = (await res.json()) as { jobId?: string };
    return Response.json({ status: "queued", jobId: result.jobId ?? null });
  } catch (err) {
    return Response.json(
      { status: "unavailable", reason: err instanceof Error ? err.message : "request failed" },
      { status: 503 },
    );
  }
}
