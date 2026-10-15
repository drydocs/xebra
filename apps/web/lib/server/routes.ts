import { CCTP_DOMAIN, evmChainForDomain, isArcToSolana, isEvmRoute } from "@xebra/network-config";

/**
 * Which burns the server will ask Circle about, and how each chain writes a transaction hash.
 *
 * The API routes started life with one source, Stellar, and a bare `?tx=` still means exactly that:
 * every link already sent to someone keeps working. A burn made on an EVM chain names its chain
 * with `&src=<CCTP domain>`, because the same 32 bytes could be a transaction on any of them.
 *
 * Only domains this product actually burns on are accepted. These routes proxy Circle's API on our
 * rate budget, and are not a general-purpose lookup for every chain Circle supports.
 */

export type SourceKind = "stellar" | "evm";

export interface Source {
  domain: number;
  kind: SourceKind;
}

const STELLAR_HASH = /^[0-9a-f]{64}$/;
const EVM_HASH = /^0x[0-9a-f]{64}$/;
const DOMAIN = /^\d{1,4}$/;

/**
 * The source a request names. `stellarDomain` is passed in (it has a server-side override) and is
 * what an absent `src` means.
 */
export function readSource(raw: string | null, stellarDomain: number): Source | null {
  if (raw === null || raw === "") return { domain: stellarDomain, kind: "stellar" };
  if (!DOMAIN.test(raw)) return null;
  const domain = Number(raw);
  if (domain === stellarDomain) return { domain, kind: "stellar" };
  return evmChainForDomain(domain) ? { domain, kind: "evm" } : null;
}

/**
 * A transaction hash in the form Circle indexes it for that kind of chain, or null if it is not
 * one. Stellar hashes are bare hex; EVM hashes carry `0x`. Neither is accepted in the other's form:
 * a hash pasted against the wrong source should be told so, not looked up and reported "pending".
 */
export function normaliseTxHash(kind: SourceKind, raw: string | null | undefined): string | null {
  const tx = raw?.trim().toLowerCase();
  if (!tx) return null;
  return (kind === "evm" ? EVM_HASH : STELLAR_HASH).test(tx) ? tx : null;
}

export const txHashHint = (kind: SourceKind) =>
  kind === "evm"
    ? "tx must be 0x followed by 64 hex characters"
    : "tx must be a 64-character hex string";

/** A CCTP domain from a query parameter, or null. */
export function readDomain(raw: string | null): number | null {
  return raw !== null && DOMAIN.test(raw) ? Number(raw) : null;
}

/**
 * Whether a quote may be asked for between two domains: the wrapper's Stellar routes (to Solana and
 * to every EVM chain in the table, Arc included), and the direct routes (each EVM peer with Arc,
 * both ways, and Arc to Solana).
 *
 * Stellar's list is every destination the wrapper *could* have committed, not the ones it has: a
 * quote is a public fact about Circle, and the contract, which is read by the page, decides what can
 * actually be sent.
 */
export function isOfferedRoute(
  source: number,
  destination: number,
  stellarDomain: number,
): boolean {
  if (source === stellarDomain) {
    return destination === CCTP_DOMAIN.solana || evmChainForDomain(destination) !== null;
  }
  return isEvmRoute(source, destination) || isArcToSolana(source, destination);
}
