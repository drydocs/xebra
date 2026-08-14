import { ChainId } from "@xebra/intent-schema";

/** Human-readable corridor id convention (e.g. "stellar->solana"), shared by whatever seeds
 *  packages/db's `corridors` table and this projector's writes, so both agree on the same FK
 *  values without a lookup table for something this static. */
const CHAIN_SLUG: Record<ChainId, string> = {
  [ChainId.ArcEvm]: "arc",
  [ChainId.Stellar]: "stellar",
  [ChainId.Solana]: "solana",
};

export function corridorId(sourceChain: ChainId, destChain: ChainId): string {
  return `${CHAIN_SLUG[sourceChain]}->${CHAIN_SLUG[destChain]}`;
}
