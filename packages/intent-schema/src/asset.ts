import { sha256 } from "@noble/hashes/sha2";
import bs58 from "bs58";
import { isAddress } from "viem";
import { ZERO_HEX32, bytesToHex32, leftPadToHex32, rightBytesFromHex32 } from "./hex.js";
import { AssetKind, type AssetRef, ChainId } from "./types.js";

// ---------------------------------------------------------------------------
// Stellar classic assets
// ---------------------------------------------------------------------------

/** sha256(assetCode || issuerAccountId) — v1 spec convention, unchanged. */
export function stellarClassicAssetRef(assetCode: string, issuerAccountId: string): AssetRef {
  const bytes = new TextEncoder().encode(`${assetCode}${issuerAccountId}`);
  return {
    chainId: ChainId.Stellar,
    kind: AssetKind.StellarClassicAsset,
    assetId: bytesToHex32(sha256(bytes)),
  };
}

export function nativeXlmAssetRef(): AssetRef {
  return { chainId: ChainId.Stellar, kind: AssetKind.Native, assetId: ZERO_HEX32 };
}

/**
 * Wraps an already-computed `sha256(assetCode||issuer)` (or the zero hash for native XLM) as
 * an `AssetRef` — used when reading a raw `destAsset` value off-chain (e.g. from the Arc
 * contract's legacy struct) rather than deriving it fresh from an asset code + issuer pair.
 */
export function stellarClassicAssetRefFromRaw(assetId: AssetRef["assetId"]): AssetRef {
  return {
    chainId: ChainId.Stellar,
    kind: assetId.toLowerCase() === ZERO_HEX32 ? AssetKind.Native : AssetKind.StellarClassicAsset,
    assetId,
  };
}

// ---------------------------------------------------------------------------
// Solana SPL tokens
// ---------------------------------------------------------------------------

/** SPL mints are already 32 bytes — used directly as the asset id, no hashing needed. */
export function splTokenAssetRef(mintBase58: string): AssetRef {
  const raw = bs58.decode(mintBase58);
  if (raw.length !== 32) {
    throw new Error(`SPL mint must decode to 32 bytes, got ${raw.length}: ${mintBase58}`);
  }
  return { chainId: ChainId.Solana, kind: AssetKind.SplToken, assetId: bytesToHex32(raw) };
}

export function assetRefToSplMint(asset: AssetRef): string {
  assertKind(asset, AssetKind.SplToken, ChainId.Solana);
  return bs58.encode(rightBytesFromHex32(asset.assetId, 32));
}

export function nativeSolAssetRef(): AssetRef {
  return { chainId: ChainId.Solana, kind: AssetKind.Native, assetId: ZERO_HEX32 };
}

// ---------------------------------------------------------------------------
// EVM ERC-20s (Arc)
// ---------------------------------------------------------------------------

export function evmErc20AssetRef(contractAddress: string): AssetRef {
  if (!isAddress(contractAddress)) {
    throw new Error(`not a valid EVM address: ${contractAddress}`);
  }
  const bytes = hexStringToBytes(contractAddress.slice(2));
  return { chainId: ChainId.ArcEvm, kind: AssetKind.EvmErc20, assetId: leftPadToHex32(bytes) };
}

export function assetRefToEvmAddress(asset: AssetRef): string {
  assertKind(asset, AssetKind.EvmErc20, ChainId.ArcEvm);
  const bytes = rightBytesFromHex32(asset.assetId, 20);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return `0x${hex}`;
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function assertKind(asset: AssetRef, kind: AssetKind, chainId: ChainId): void {
  if (asset.kind !== kind || asset.chainId !== chainId) {
    throw new Error(
      `expected AssetRef{chainId: ${chainId}, kind: ${kind}}, got ${JSON.stringify(asset)}`,
    );
  }
}

function hexStringToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
