/**
 * Bidirectional mapping between the frozen Arc contract's legacy EIP-712 `Intent` struct
 * (contracts/arc-evm/src/XebraEscrow.sol) and `IntentV2`. The Arc contract itself never
 * changes — this adapter is what lets the DB/API/frontend represent the Arc->Stellar corridor
 * uniformly alongside the new Stellar->Solana corridor. See docs/architecture.md §1.
 */

import {
  chainAddressToEvmAddress,
  evmAddressToChainAddress,
  stellarAddressToChainAddress,
} from "../address.js";
import {
  assetRefToEvmAddress,
  evmErc20AssetRef,
  nativeXlmAssetRef,
  stellarClassicAssetRefFromRaw,
} from "../asset.js";
import type { ArcLegacyIntent } from "../hash.js";
import { assertHex32, isZeroHex32 } from "../hex.js";
import { AddrEncoding, ChainId, type Hex32, type IntentV2 } from "../types.js";

export function arcLegacyToIntentV2(legacy: ArcLegacyIntent): IntentV2 {
  return {
    version: 2,
    user: evmAddressToChainAddress(legacy.user),
    sourceChain: ChainId.ArcEvm,
    sourceAsset: evmErc20AssetRef(legacy.sourceToken),
    sourceAmount: legacy.sourceAmount,
    destChain: ChainId.Stellar,
    destAsset: stellarClassicAssetRefFromRaw(assertHex32(legacy.destAsset)),
    minDestAmount: legacy.minDestAmount,
    destAddress: rawHex32ToStellarChainAddress(assertHex32(legacy.destAddress)),
    expiry: legacy.expiry,
    nonce: legacy.nonce,
  };
}

export function intentV2ToArcLegacy(intent: IntentV2): ArcLegacyIntent {
  if (intent.sourceChain !== ChainId.ArcEvm) {
    throw new Error(`intentV2ToArcLegacy: sourceChain must be ArcEvm, got ${intent.sourceChain}`);
  }
  if (intent.destChain !== ChainId.Stellar) {
    throw new Error(`intentV2ToArcLegacy: destChain must be Stellar, got ${intent.destChain}`);
  }
  return {
    user: chainAddressToEvmAddress(intent.user) as `0x${string}`,
    sourceToken: assetRefToEvmAddress(intent.sourceAsset) as `0x${string}`,
    sourceAmount: intent.sourceAmount,
    destAsset: intent.destAsset.assetId,
    minDestAmount: intent.minDestAmount,
    destAddress: intent.destAddress.raw,
    expiry: intent.expiry,
    nonce: intent.nonce,
  };
}

/**
 * The legacy struct's `destAddress` is already a raw 32-byte Stellar ed25519 pubkey (per the
 * v1 spec) — this just wraps it as a `ChainAddress` without needing StrKey encode/decode,
 * since no base32/checksum round-trip is involved going to/from the raw on-chain bytes.
 */
function rawHex32ToStellarChainAddress(raw: Hex32) {
  return { chainId: ChainId.Stellar, encoding: AddrEncoding.StellarEd25519_32, raw };
}

// re-exported for tests / other adapters that only have the raw hash already.
export { stellarAddressToChainAddress, nativeXlmAssetRef };
export const isNativeXlm = isZeroHex32;
