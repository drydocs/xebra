import { StrKey } from "@stellar/stellar-base";
import bs58 from "bs58";
import { getAddress, isAddress } from "viem";
import { bytesToHex32, leftPadToHex32, rightBytesFromHex32 } from "./hex.js";
import { AddrEncoding, type ChainAddress, ChainId } from "./types.js";

// ---------------------------------------------------------------------------
// EVM (Arc)
// ---------------------------------------------------------------------------

export function evmAddressToChainAddress(address: string): ChainAddress {
  if (!isAddress(address)) {
    throw new Error(`not a valid EVM address: ${address}`);
  }
  const checksummed = getAddress(address);
  const bytes = hexStringToBytes(checksummed.slice(2));
  return {
    chainId: ChainId.ArcEvm,
    encoding: AddrEncoding.EvmAddress20,
    raw: leftPadToHex32(bytes),
  };
}

export function chainAddressToEvmAddress(addr: ChainAddress): string {
  assertEncoding(addr, AddrEncoding.EvmAddress20);
  const bytes = rightBytesFromHex32(addr.raw, 20);
  return getAddress(`0x${bytesToHexString(bytes)}`);
}

// ---------------------------------------------------------------------------
// Stellar
// ---------------------------------------------------------------------------

export function stellarAddressToChainAddress(gAddress: string): ChainAddress {
  const raw = StrKey.decodeEd25519PublicKey(gAddress);
  return {
    chainId: ChainId.Stellar,
    encoding: AddrEncoding.StellarEd25519_32,
    raw: bytesToHex32(new Uint8Array(raw)),
  };
}

export function chainAddressToStellarAddress(addr: ChainAddress): string {
  assertEncoding(addr, AddrEncoding.StellarEd25519_32);
  const bytes = rightBytesFromHex32(addr.raw, 32);
  return StrKey.encodeEd25519PublicKey(Buffer.from(bytes));
}

// ---------------------------------------------------------------------------
// Solana
// ---------------------------------------------------------------------------

export function solanaAddressToChainAddress(pubkeyBase58: string): ChainAddress {
  const raw = bs58.decode(pubkeyBase58);
  if (raw.length !== 32) {
    throw new Error(`solana pubkey must decode to 32 bytes, got ${raw.length}: ${pubkeyBase58}`);
  }
  return {
    chainId: ChainId.Solana,
    encoding: AddrEncoding.SolanaEd25519_32,
    raw: bytesToHex32(raw),
  };
}

export function chainAddressToSolanaAddress(addr: ChainAddress): string {
  assertEncoding(addr, AddrEncoding.SolanaEd25519_32);
  const bytes = rightBytesFromHex32(addr.raw, 32);
  return bs58.encode(bytes);
}

// ---------------------------------------------------------------------------
// Internal
// ---------------------------------------------------------------------------

function assertEncoding(addr: ChainAddress, expected: AddrEncoding): void {
  if (addr.encoding !== expected) {
    throw new Error(`expected ChainAddress encoding ${expected}, got ${addr.encoding}`);
  }
}

function hexStringToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHexString(bytes: Uint8Array): string {
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
