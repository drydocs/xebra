/**
 * Tells the relay about a burn that was just signed, so it sponsors the Solana mint.
 *
 * Never throws. The burn has already happened by the time this runs, and the mint is
 * permissionless — anyone holding the attestation can complete it, including the user from
 * `/recover`. An exception escaping here would surface as "the transfer failed" for a transfer
 * that in fact succeeded, which is both wrong and alarming. The caller gets a status to
 * display instead.
 */

export type RelayHandoff =
  | { status: "queued"; jobId: string | null }
  /** The burn is not searchable yet, but the on-chain watcher will find it. Not a failure. */
  | { status: "watching" }
  | { status: "unavailable"; reason: string };

export async function handOffToRelay(txHash: string): Promise<RelayHandoff> {
  try {
    const res = await fetch("/api/relay/burns", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ txHash }),
    });
    const body = (await res.json()) as Partial<RelayHandoff> & { reason?: string };
    if (res.ok && body.status === "queued") {
      return { status: "queued", jobId: (body as { jobId: string | null }).jobId ?? null };
    }
    if (res.ok && body.status === "watching") return { status: "watching" };
    return { status: "unavailable", reason: body.reason ?? `relay returned ${res.status}` };
  } catch (err) {
    return {
      status: "unavailable",
      reason: err instanceof Error ? err.message : "could not reach the relay",
    };
  }
}
