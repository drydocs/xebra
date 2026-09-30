/**
 * Where a burn has got to, read from what Iris says about it.
 *
 * With Circle's Forwarding Service there is one place to look. Iris reports the attestation and, for
 * a forwarded burn, `forwardState` and `forwardTxHash` for the mint Circle sends on the destination.
 * We do not mint anything ourselves, so there is no second system to consult.
 *
 * The states are the ones a person needs to act on, not Iris's own vocabulary:
 *
 *   - `waiting`    Iris has no attestation for it yet. Nothing to do.
 *   - `forwarding` Attested; Circle has not reported the destination mint yet. Nothing to do — but
 *                  `forwardState` lags the real mint, so a long stay here is worth a nudge to
 *                  check the destination, not an error.
 *   - `delivered`  Circle reports the forward complete.
 *   - `failed`     Circle reports the forward failed (e.g. `INSUFFICIENT_FEE`). The attestation
 *                  exists, so the owner can mint it themselves at `/claim`.
 *   - `claimable`  Attested, and the burn asked for no forwarding (a transfer made before the
 *                  forwarding wrapper). Same remedy as `failed`.
 *
 * Circle documents `forwardState` and `forwardTxHash`; the error fields are not in its published
 * schema, so they are read defensively and only ever used as display text.
 */

export type DeliveryState = "waiting" | "forwarding" | "delivered" | "failed" | "claimable";

export interface Delivery {
  state: DeliveryState;
  /** The destination-chain transaction, once Circle reports it. */
  forwardTxHash: string | null;
  /** Circle's reason, when it gave one. Display text only. */
  reason: string | null;
}

const WAITING: Delivery = { state: "waiting", forwardTxHash: null, reason: null };

function text(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Reads the body of `GET /v2/messages/{domain}?transactionHash=…`. Never throws. */
export function readDelivery(body: unknown): Delivery {
  const messages = (body as { messages?: unknown } | null)?.messages;
  if (!Array.isArray(messages) || messages.length === 0) return WAITING;
  const m = messages[0] as Record<string, unknown> | null;
  if (!m || typeof m !== "object") return WAITING;

  const attested = m.status === "complete" && text(m.attestation) !== null;
  const fwd = text(m.forwardState)?.toUpperCase() ?? null;
  const forwardTxHash = text(m.forwardTxHash);

  // A failure is visible before the attestation is final, and it is the thing to act on.
  if (fwd === "FAILED") {
    const code = text(m.forwardErrorCode);
    const details = text(m.forwardErrorDetails);
    return {
      state: "failed",
      forwardTxHash: null,
      reason: [code, details].filter(Boolean).join(": ") || null,
    };
  }
  if (fwd === "COMPLETE") return { state: "delivered", forwardTxHash, reason: null };
  if (!attested) return WAITING;
  if (fwd === null) return { state: "claimable", forwardTxHash: null, reason: null };
  return { state: "forwarding", forwardTxHash, reason: null };
}
