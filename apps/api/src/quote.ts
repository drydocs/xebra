import type { AssetRef, ChainId } from "@xebra/intent-schema";
import {
  type CorridorConfig,
  RouteError,
  StaticUsdcRegistry,
  resolveRoute,
} from "@xebra/router-core";

/**
 * Turns repository rows (packages/db shapes) into the plain config `resolveRoute` expects, then
 * resolves the rail. This is apps/api's authoritative routing check (docs/architecture.md §6) —
 * the frontend calls the same `resolveRoute` function client-side for instant UX, but a
 * submission is only accepted if this server-side call agrees.
 */

export interface CorridorRow {
  id: string;
  sourceChainId: number;
  destChainId: number;
  escrowContractAddress: string | null;
  active: boolean;
}

export interface UsdcAssetRow {
  chainId: number;
  assetId: string;
}

export interface QuoteInput {
  sourceChain: ChainId;
  destChain: ChainId;
  destAsset: AssetRef;
}

export function buildCorridorConfigs(rows: CorridorRow[]): CorridorConfig[] {
  return rows.map((row) => ({
    sourceChain: row.sourceChainId as ChainId,
    destChain: row.destChainId as ChainId,
    active: row.active,
    ...(row.escrowContractAddress ? { escrowAddress: row.escrowContractAddress } : {}),
  }));
}

export function buildUsdcRegistry(rows: UsdcAssetRow[]): StaticUsdcRegistry {
  return new StaticUsdcRegistry(
    rows.map((row) => ({ chainId: row.chainId as ChainId, usdcAssetId: row.assetId })),
  );
}

export function resolveQuote(
  input: QuoteInput,
  corridorRows: CorridorRow[],
  usdcRows: UsdcAssetRow[],
) {
  return resolveRoute(input, buildCorridorConfigs(corridorRows), buildUsdcRegistry(usdcRows));
}

export { RouteError };
