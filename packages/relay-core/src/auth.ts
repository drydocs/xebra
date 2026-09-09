import { createHash, timingSafeEqual } from "node:crypto";

/**
 * Shared request checks for whichever front door the relay is behind — the standalone HTTP
 * server in `apps/cctp-relay`, or a Next.js route handler on Vercel. Duplicating a bearer-token
 * comparison is how one copy quietly ends up using `===`.
 */

/** Stellar transaction hashes are 32 bytes, lower-case hex. Rejecting anything else keeps
 *  malformed input out of the job table, where it would occupy the unique index forever. */
const TX_HASH = /^[0-9a-f]{64}$/;

export function isStellarTxHash(value: unknown): value is string {
  return typeof value === "string" && TX_HASH.test(value);
}

/**
 * Constant-time bearer check.
 *
 * Compared over SHA-256 digests rather than the raw strings, which both hides the token's length
 * and satisfies `timingSafeEqual`'s equal-length requirement without branching on length — a
 * length branch is itself a timing signal.
 */
export function authorizeBearer(header: string | null | undefined, token: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice("Bearer ".length)), digest(token));
}
