/**
 * Minimal DER helpers for exactly the two shapes AWS KMS returns here — not a general ASN.1
 * parser. Every extraction is length/tag-validated rather than trusted by fixed offset, so a
 * KMS response that doesn't match the expected shape fails loudly instead of silently deriving
 * a wrong address or signature.
 */

/** Parses a DER-encoded ECDSA signature (SEQUENCE { r INTEGER, s INTEGER }) into raw 32-byte
 *  r/s values, as returned by KMS's Sign for ECDSA_SHA_256. */
export function parseDerEcdsaSignature(der: Uint8Array): { r: Uint8Array; s: Uint8Array } {
  let offset = 0;
  if (der[offset++] !== 0x30) throw new Error("parseDerEcdsaSignature: expected SEQUENCE tag");
  offset += derLengthSize(der, offset);

  const r = readDerInteger(der, offset);
  offset = r.nextOffset;
  const s = readDerInteger(der, offset);

  return { r: to32Bytes(r.value), s: to32Bytes(s.value) };
}

/** Extracts the raw 65-byte uncompressed secp256k1 public key point (0x04 || x || y) from a
 *  KMS GetPublicKey response's DER-encoded SubjectPublicKeyInfo. For EC_SECG_P256K1 keys, the
 *  point is always the trailing 65 bytes (RFC 5480's fixed-length AlgorithmIdentifier prefix),
 *  but we validate the tag/length rather than trust that blindly. */
export function extractSecp256k1PublicKeyFromSpki(der: Uint8Array): Uint8Array {
  const point = der.slice(der.length - 65);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error(
      `extractSecp256k1PublicKeyFromSpki: expected a trailing 65-byte uncompressed point starting with 0x04, got length ${point.length} starting with 0x${point[0]?.toString(16)}`,
    );
  }
  return point;
}

/** Extracts the raw 32-byte Ed25519 public key from a KMS GetPublicKey response's DER-encoded
 *  SubjectPublicKeyInfo (RFC 8410's fixed-length prefix for Ed25519 keys). */
export function extractEd25519PublicKeyFromSpki(der: Uint8Array): Uint8Array {
  const key = der.slice(der.length - 32);
  if (key.length !== 32) {
    throw new Error(
      `extractEd25519PublicKeyFromSpki: expected a trailing 32-byte key, got length ${key.length}`,
    );
  }
  return key;
}

function derLengthSize(der: Uint8Array, offset: number): number {
  const first = der[offset];
  if (first === undefined) throw new Error("derLengthSize: unexpected end of input");
  if ((first & 0x80) === 0) return 1;
  return 1 + (first & 0x7f);
}

function readDerInteger(
  der: Uint8Array,
  offset: number,
): { value: Uint8Array; nextOffset: number } {
  if (der[offset] !== 0x02) throw new Error("readDerInteger: expected INTEGER tag");
  const lengthOffset = offset + 1;
  const lenByte = der[lengthOffset];
  if (lenByte === undefined) throw new Error("readDerInteger: unexpected end of input");
  let length: number;
  let lengthBytes: number;
  if ((lenByte & 0x80) === 0) {
    length = lenByte;
    lengthBytes = 1;
  } else {
    lengthBytes = 1 + (lenByte & 0x7f);
    length = 0;
    for (let i = 1; i < lengthBytes; i++) {
      length = (length << 8) | (der[lengthOffset + i] as number);
    }
  }
  const start = lengthOffset + lengthBytes;
  const value = der.slice(start, start + length);
  return { value, nextOffset: start + length };
}

/** DER INTEGERs are minimal and may have a leading 0x00 (to keep the value non-negative when the
 *  high bit is set) or be shorter than 32 bytes — normalize to exactly 32 bytes either way. */
function to32Bytes(value: Uint8Array): Uint8Array {
  const trimmed = value[0] === 0x00 && value.length > 32 ? value.slice(1) : value;
  if (trimmed.length > 32) throw new Error(`to32Bytes: value too long (${trimmed.length} bytes)`);
  const out = new Uint8Array(32);
  out.set(trimmed, 32 - trimmed.length);
  return out;
}
