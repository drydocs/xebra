import type { AssetRef, ChainId } from "@xebra/intent-schema";

/**
 * CCTP-direct vs intent/swap routing rule. Pure function, shared by apps/web (instant
 * quote-time UX) and apps/api (the authoritative check before accepting a submission — the
 * frontend copy is a UX optimization only, the backend is the source of truth so a
 * manipulated client can't force the wrong rail). See docs/architecture.md §6.
 */

export type Rail = "cctp-direct" | "intent-swap";

/** One row per live (sourceChain, destChain) pair. `escrowAddress` absent => this corridor has
 *  no intent/swap rail, only CCTP-direct — routing a non-USDC request through it is an error. */
export interface CorridorConfig {
  sourceChain: ChainId;
  destChain: ChainId;
  active: boolean;
  escrowAddress?: string;
}

/** Resolves whether a given AssetRef is the canonical native-USDC asset on its chain. Backed by
 *  a small static registry in the common case; kept as an interface so a caller (e.g. tests, or
 *  a future chain) can inject its own without this package hard-depending on chain-specific
 *  asset addresses. */
export interface NativeUsdcRegistry {
  isNativeUsdc(chainId: ChainId, asset: AssetRef): boolean;
}

export interface RouteInput {
  sourceChain: ChainId;
  destChain: ChainId;
  destAsset: AssetRef;
}

export interface RouteResult {
  rail: Rail;
  corridor: CorridorConfig;
}

export class RouteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RouteError";
  }
}

export function resolveRoute(
  input: RouteInput,
  corridors: readonly CorridorConfig[],
  usdcRegistry: NativeUsdcRegistry,
): RouteResult {
  const corridor = corridors.find(
    (c) => c.sourceChain === input.sourceChain && c.destChain === input.destChain && c.active,
  );
  if (!corridor) {
    throw new RouteError(`no active corridor for ${input.sourceChain} -> ${input.destChain}`);
  }

  const isUsdcToUsdc = usdcRegistry.isNativeUsdc(input.destChain, input.destAsset);
  if (isUsdcToUsdc) {
    return { rail: "cctp-direct", corridor };
  }

  if (!corridor.escrowAddress) {
    throw new RouteError(
      `corridor ${input.sourceChain} -> ${input.destChain} has no intent/swap escrow and the requested destination asset is not native USDC — nothing can fill this request`,
    );
  }

  return { rail: "intent-swap", corridor };
}
