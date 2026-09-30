import type { CircleHealth, Delivery } from "@xebra/cctp-client";

/**
 * The browser's view of two server routes that read Circle for it: how a burn is getting on, and
 * whether it is safe to start one. Both are budgeted server-side (`lib/server/iris.ts`), so polling
 * them cannot get us rate limited.
 *
 * Neither ever throws. The burn is already on chain by the time the first runs, and a failed status
 * check says nothing about the money; the second must never become a reason a working product
 * refuses to work.
 */

export type DeliveryView =
  | ({ status: "known" } & Delivery)
  /** Could not ask. Deliberately not "waiting" — an unanswerable question is not progress. */
  | { status: "unknown"; reason: string };

export async function getDelivery(txHash: string): Promise<DeliveryView> {
  try {
    const res = await fetch(`/api/delivery?tx=${encodeURIComponent(txHash)}`);
    if (!res.ok) return { status: "unknown", reason: `status returned ${res.status}` };
    const body = (await res.json()) as DeliveryView;
    if (body.status === "known" && typeof body.state === "string") return body;
    return { status: "unknown", reason: "no answer" };
  } catch {
    return { status: "unknown", reason: "could not reach the status service" };
  }
}

/**
 * Whether Circle looks able to carry a transfer to `dest` right now.
 *
 * Returns `null` when the check itself could not be run. That is not `down`: our own server being
 * unreachable says nothing about Circle, and refusing to send on that basis would make this check a
 * single point of failure for the product.
 */
export async function getCircleHealth(
  dest: "solana" | "arc",
  newAccount: boolean,
): Promise<CircleHealth | null> {
  try {
    const q = new URLSearchParams({ dest });
    if (newAccount) q.set("newAccount", "1");
    const res = await fetch(`/api/circle-health?${q}`);
    if (!res.ok) return null;
    const body = (await res.json()) as CircleHealth;
    return body.status === "ok" || body.status === "degraded" || body.status === "down"
      ? body
      : null;
  } catch {
    return null;
  }
}
