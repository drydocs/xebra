import type { intents } from "@xebra/db";
import type { ChainEvent } from "@xebra/event-bus";
import { AddrEncoding, ChainId } from "@xebra/intent-schema";
import { corridorId } from "./corridor-id.js";

type NewIntentRow = typeof intents.$inferInsert;

/**
 * Maps an `IntentOpened` ChainEvent into a row for `packages/db`'s `intents` table. Two
 * distinct mappers, not one generic one: Arc's decoded event payload uses the ABI's own
 * camelCase arg names (see @xebra/chain-adapters' `decode.ts`), Soroban's uses the contract
 * struct's snake_case field names (see `decode-soroban-events.ts`) — genuinely different shapes,
 * not worth forcing through a shared schema that would just be a pile of `??` fallbacks.
 *
 * Both return `null` for a payload that doesn't match the expected shape rather than throwing,
 * matching apps/solver's `intentFromChainEvent` — a malformed or unrelated event on the same
 * topic shouldn't crash the projector.
 */
export function projectIntentOpened(event: ChainEvent): NewIntentRow | null {
  if (event.eventType !== "IntentOpened" || !event.intentHash) return null;

  if (event.chainId === ChainId.ArcEvm) {
    return projectArcIntentOpened(event);
  }
  if (event.chainId === ChainId.Stellar) {
    return projectSorobanIntentOpened(event);
  }
  return null;
}

function projectArcIntentOpened(event: ChainEvent): NewIntentRow | null {
  const p = event.payload;
  if (
    typeof p.user !== "string" ||
    typeof p.sourceToken !== "string" ||
    typeof p.sourceAmount !== "string" ||
    typeof p.destAsset !== "string" ||
    typeof p.minDestAmount !== "string" ||
    typeof p.destAddress !== "string" ||
    typeof p.expiry !== "string" ||
    typeof p.nonce !== "string"
  ) {
    return null;
  }

  return {
    intentHash: event.intentHash as string,
    corridorId: corridorId(ChainId.ArcEvm, ChainId.Stellar),
    user: { chainId: ChainId.ArcEvm, encoding: AddrEncoding.EvmAddress20, raw: p.user },
    sourceAssetId: p.sourceToken,
    sourceAmount: p.sourceAmount,
    destAssetId: p.destAsset,
    minDestAmount: p.minDestAmount,
    destAddress: {
      chainId: ChainId.Stellar,
      encoding: AddrEncoding.StellarEd25519_32,
      raw: p.destAddress,
    },
    expiry: new Date(Number(p.expiry) * 1000),
    nonce: p.nonce,
    status: "open",
    rawIntent: p,
  };
}

function projectSorobanIntentOpened(event: ChainEvent): NewIntentRow | null {
  const p = event.payload;
  const destChain = p.dest_chain;
  if (
    typeof p.user !== "string" ||
    typeof p.source_token !== "string" ||
    typeof p.source_amount !== "string" ||
    typeof destChain !== "number" ||
    typeof p.dest_asset !== "string" ||
    typeof p.min_dest_amount !== "string" ||
    typeof p.dest_address !== "string" ||
    typeof p.expiry !== "string" ||
    typeof p.nonce !== "string"
  ) {
    return null;
  }

  return {
    intentHash: event.intentHash as string,
    corridorId: corridorId(ChainId.Stellar, destChain as ChainId),
    user: { chainId: ChainId.Stellar, encoding: AddrEncoding.StellarEd25519_32, raw: p.user },
    sourceAssetId: p.source_token,
    sourceAmount: p.source_amount,
    destAssetId: p.dest_asset,
    minDestAmount: p.min_dest_amount,
    destAddress: {
      chainId: destChain as ChainId,
      encoding: AddrEncoding.SolanaEd25519_32,
      raw: p.dest_address,
    },
    expiry: new Date(Number(p.expiry) * 1000),
    nonce: p.nonce,
    status: "open",
    rawIntent: p,
  };
}
