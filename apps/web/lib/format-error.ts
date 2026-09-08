/**
 * Turns anything that was thrown into text a person can act on.
 *
 * # Why this exists
 *
 * `String(err)` on a non-Error object produces the literal text `[object Object]`, which is
 * what the bridge UI showed for a failed transfer — destroying the only evidence of what went
 * wrong. That is not a hypothetical: neither of the two things most likely to reject here
 * throws an `Error`.
 *
 * - **Wallet kits** reject with plain objects — Freighter surfaces `{ error: { code, message } }`
 *   or a bare `{ message }` depending on the failure.
 * - **@stellar/stellar-sdk** returns/throws structured results: `sendTransaction` yields
 *   `{ status, errorResult, hash }`, and simulation failures carry `{ error }` strings
 *   containing the diagnostic event log.
 *
 * So the formatter walks the known shapes first, then falls back to JSON — and never to
 * `String()`, which is the one option that guarantees losing the information.
 */

/** Common message-bearing fields, in the order worth trying. */
const MESSAGE_KEYS = ["message", "error", "detail", "description", "reason"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Extracts the most specific human-readable string available, recursing one level into
 * nested `error`/`cause` wrappers (Freighter nests, and `Error.cause` chains do too).
 */
export function formatError(err: unknown, depth = 0): string {
  if (err === null || err === undefined) return "Unknown error.";
  if (typeof err === "string") return err;
  if (typeof err === "number" || typeof err === "boolean") return String(err);

  if (err instanceof Error) {
    // `cause` frequently holds the real failure while `message` is generic.
    const cause = (err as { cause?: unknown }).cause;
    if (depth < 3 && cause !== undefined && err.message.length < 40) {
      const inner = formatError(cause, depth + 1);
      if (inner && inner !== "Unknown error.") return `${err.message}: ${inner}`;
    }
    return err.message || err.name || "Error";
  }

  if (isRecord(err)) {
    for (const key of MESSAGE_KEYS) {
      const value = err[key];
      if (typeof value === "string" && value.trim() !== "") return value;
      // Freighter: { error: { code, message } }
      if (depth < 3 && isRecord(value)) {
        const nested = formatError(value, depth + 1);
        if (nested && nested !== "Unknown error." && !nested.startsWith("{")) return nested;
      }
    }

    // stellar-sdk's sendTransaction failure shape.
    if ("status" in err) {
      const parts = [`status ${String(err.status)}`];
      if (err.hash) parts.push(`tx ${String(err.hash)}`);
      if (err.errorResult) parts.push(safeJson(err.errorResult));
      return parts.join(" — ");
    }

    return safeJson(err);
  }

  return safeJson(err);
}

function safeJson(value: unknown): string {
  try {
    const out = JSON.stringify(
      value,
      (_key, v) => (typeof v === "bigint" ? v.toString() : v),
      2,
    );
    // JSON.stringify returns undefined for functions/symbols and "{}" for objects whose own
    // properties are all non-enumerable — which is exactly the case that produced
    // "[object Object]" before. Say so rather than showing an empty brace pair.
    if (!out || out === "{}") {
      const keys = isRecord(value) ? Object.getOwnPropertyNames(value) : [];
      if (keys.length > 0) {
        return keys.map((k) => `${k}: ${String((value as Record<string, unknown>)[k])}`).join(", ");
      }
      return "An error with no readable detail was thrown.";
    }
    return out;
  } catch {
    return "An error that could not be serialized was thrown.";
  }
}

/**
 * Formats for display AND logs the raw value to the console.
 *
 * The console copy matters: the formatted string is deliberately trimmed for a user, while
 * a Soroban failure's real diagnostic event log — the part naming the failing host function
 * and contract error code — is far too long to put in the UI but is exactly what is needed
 * to debug one.
 */
export function reportError(context: string, err: unknown): string {
  // biome-ignore lint/suspicious/noConsole: this is the diagnostic path for failed transfers.
  console.error(`[xebra] ${context}`, err);
  return formatError(err);
}
