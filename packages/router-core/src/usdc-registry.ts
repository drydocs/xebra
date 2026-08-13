import type { AssetRef, ChainId } from "@xebra/intent-schema";
import type { NativeUsdcRegistry } from "./route.js";

/** Plain map-backed `NativeUsdcRegistry`: one canonical `AssetRef.assetId` per chain. Matches
 *  on `chainId` + `assetId` only (case-insensitive hex compare) — `kind` isn't checked, since
 *  the point is "is this specific asset id the chain's USDC", not "is it tagged as USDC". */
export class StaticUsdcRegistry implements NativeUsdcRegistry {
  private readonly byChain = new Map<ChainId, string>();

  constructor(entries: ReadonlyArray<{ chainId: ChainId; usdcAssetId: string }>) {
    for (const { chainId, usdcAssetId } of entries) {
      this.byChain.set(chainId, usdcAssetId.toLowerCase());
    }
  }

  isNativeUsdc(chainId: ChainId, asset: AssetRef): boolean {
    const usdcAssetId = this.byChain.get(chainId);
    if (!usdcAssetId) return false;
    return asset.chainId === chainId && asset.assetId.toLowerCase() === usdcAssetId;
  }
}
