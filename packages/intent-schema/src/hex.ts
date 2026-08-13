import type { Hex32 } from "./types.js";

export const ZERO_HEX32: Hex32 = `0x${"0".repeat(64)}`;

export function bytesToHex32(bytes: Uint8Array): Hex32 {
  if (bytes.length !== 32) {
    throw new Error(`bytesToHex32: expected 32 bytes, got ${bytes.length}`);
  }
  let hex = "";
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, "0");
  }
  return `0x${hex}`;
}

export function hex32ToBytes(hex: Hex32): Uint8Array {
  const stripped = assertHex32(hex).slice(2);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    bytes[i] = Number.parseInt(stripped.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Left-pads `bytes` (at most 32 long) into a 32-byte hex slot — e.g. a 20-byte EVM address. */
export function leftPadToHex32(bytes: Uint8Array): Hex32 {
  if (bytes.length > 32) {
    throw new Error(`leftPadToHex32: input longer than 32 bytes (${bytes.length})`);
  }
  const padded = new Uint8Array(32);
  padded.set(bytes, 32 - bytes.length);
  return bytesToHex32(padded);
}

/** Inverse of leftPadToHex32 for a known original byte width (e.g. 20 for an EVM address). */
export function rightBytesFromHex32(hex: Hex32, width: number): Uint8Array {
  const full = hex32ToBytes(hex);
  return full.slice(32 - width);
}

export function assertHex32(hex: string): Hex32 {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error(`expected a 0x-prefixed 32-byte hex string, got: ${hex}`);
  }
  return hex as Hex32;
}

export function isZeroHex32(hex: Hex32): boolean {
  return hex.toLowerCase() === ZERO_HEX32;
}
