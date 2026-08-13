import type { ChainEvent } from "@xebra/event-bus";
import { AddrEncoding, AssetKind, ChainId, type IntentV2 } from "@xebra/intent-schema";

/**
 * Reconstructs an `IntentV2` from an `IntentOpened` ChainEvent's payload — lets the solver act
 * on live events directly rather than round-tripping through Postgres (which nothing currently
 * populates from the event bus; a Kafka->DB projector consumer is listed in
 * docs/architecture.md §8 but not yet built — see the repo README's Status section). Returns
 * `null` for anything that doesn't look like a well-formed Stellar-source IntentOpened payload
 * rather than throwing, since a malformed or unrelated event on the same topic shouldn't crash
 * the solver loop.
 */
export function intentFromChainEvent(event: ChainEvent): IntentV2 | null {
  if (
    event.eventType !== "IntentOpened" ||
    event.chainId !== ChainId.Stellar ||
    !event.intentHash
  ) {
    return null;
  }

  const p = event.payload;
  const user = p.user;
  const destAsset = p.dest_asset;
  const destAddress = p.dest_address;
  const destChain = p.dest_chain;

  if (
    typeof user !== "string" ||
    typeof destAsset !== "string" ||
    typeof destAddress !== "string" ||
    typeof destChain !== "number" ||
    typeof p.source_amount !== "string" ||
    typeof p.min_dest_amount !== "string" ||
    typeof p.expiry !== "string" ||
    typeof p.nonce !== "string"
  ) {
    return null;
  }

  return {
    version: 2,
    user: {
      chainId: ChainId.Stellar,
      encoding: AddrEncoding.StellarEd25519_32,
      raw: user as `0x${string}`,
    },
    sourceChain: ChainId.Stellar,
    sourceAsset: {
      chainId: ChainId.Stellar,
      kind: AssetKind.StellarSorobanToken,
      assetId: `0x${"0".repeat(64)}`,
    },
    sourceAmount: BigInt(p.source_amount),
    destChain: destChain as ChainId,
    destAsset: {
      chainId: destChain as ChainId,
      kind: AssetKind.SplToken,
      assetId: destAsset as `0x${string}`,
    },
    minDestAmount: BigInt(p.min_dest_amount),
    destAddress: {
      chainId: destChain as ChainId,
      encoding: AddrEncoding.SolanaEd25519_32,
      raw: destAddress as `0x${string}`,
    },
    expiry: BigInt(p.expiry),
    nonce: BigInt(p.nonce),
  };
}
