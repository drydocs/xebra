import { checkArcAddress } from "./arc-address";
import { type AddressCheck, checkSolanaAddress } from "./solana-address";

/**
 * Where a transfer can land.
 *
 * The domain ids are Circle's and never change (`packages/network-config` pins and tests them);
 * they are literals here for the reason `lib/env.ts` gives — the browser bundle should not
 * import the whole preset table to learn two integers.
 *
 * Everything that differs by destination is answered here, once, so the bridge screen asks
 * `DESTINATIONS[id]` instead of branching on a chain name in a dozen places.
 */
export type DestinationId = "solana" | "arc";

export interface Destination {
  id: DestinationId;
  name: string;
  /** Circle's CCTP domain id. */
  domain: number;
  /** Label for the recipient field. */
  addressLabel: string;
  addressPlaceholder: string;
  checkAddress(input: string): AddressCheck;
  /** Only Solana: a wallet must be resolved to its USDC token account before the burn. */
  needsAccountResolution: boolean;
  explorerTxUrl(hash: string): string;
  /** What the person who claims by hand pays, said plainly. */
  claimCost: string;
}

export const DESTINATIONS: Record<DestinationId, Destination> = {
  solana: {
    id: "solana",
    name: "Solana",
    domain: 5,
    addressLabel: "Solana address",
    addressPlaceholder: "Recipient wallet",
    checkAddress: checkSolanaAddress,
    needsAccountResolution: true,
    explorerTxUrl: (hash) => `https://solscan.io/tx/${hash}`,
    claimCost: "roughly 0.001 SOL",
  },
  arc: {
    id: "arc",
    name: "Arc",
    domain: 26,
    addressLabel: "Arc address",
    addressPlaceholder: "0x…",
    checkAddress: checkArcAddress,
    needsAccountResolution: false,
    explorerTxUrl: (hash) => `https://explorer.arc.io/tx/${hash}`,
    claimCost: "well under a cent, paid in USDC",
  },
};

/** Which destinations a build offers. Solana always; Arc only once it has been switched on. */
export function availableDestinations(arcEnabled: boolean): Destination[] {
  return arcEnabled ? [DESTINATIONS.solana, DESTINATIONS.arc] : [DESTINATIONS.solana];
}

export function destinationForDomain(domain: number): Destination | null {
  return Object.values(DESTINATIONS).find((d) => d.domain === domain) ?? null;
}
