/**
 * The server-side gate in front of /admin.
 *
 * It is a convenience layer, not the security boundary. Everything the panel shows is public chain
 * state, and every write is authorised on chain against the admin or pauser key, so someone who got
 * past this gate could read what anyone can read and could not sign anything. What the gate does is
 * keep the page (and its controls, and the addresses of the operators) out of view of everyone else.
 *
 * It fails closed: with no password configured the panel does not exist. Runs in the edge runtime,
 * so no Node APIs.
 */

/** Length-independent-ish comparison: always walks the longer string, so timing does not reveal
 *  how much of a guess was right. */
export function safeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Pulls the password out of `Authorization: Basic base64(user:password)`. The user is ignored. */
export function basicPassword(header: string | null): string | null {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6).trim());
    const i = decoded.indexOf(":");
    return i === -1 ? null : decoded.slice(i + 1);
  } catch {
    return null;
  }
}

export type GateDecision =
  | { allow: true }
  | { allow: false; status: 401 | 403 | 404; challenge: boolean };

export interface GateInput {
  password: string | undefined;
  allowedIps: string | undefined;
  authorization: string | null;
  /** First entry of x-forwarded-for, as set by the platform's proxy. */
  clientIp: string | null;
}

export function decideGate(input: GateInput): GateDecision {
  const password = input.password?.trim();
  // Too short a password is as good as none: refuse to serve rather than pretend.
  if (!password || password.length < 16) return { allow: false, status: 404, challenge: false };

  const ips = (input.allowedIps ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (ips.length > 0 && !(input.clientIp && ips.includes(input.clientIp))) {
    return { allow: false, status: 403, challenge: false };
  }

  const given = basicPassword(input.authorization);
  if (given !== null && safeEqual(given, password)) return { allow: true };
  return { allow: false, status: 401, challenge: true };
}
