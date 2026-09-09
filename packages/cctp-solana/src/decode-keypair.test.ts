import { Keypair } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { decodeRelayKeypair } from "./decode-keypair.js";

/** A local base58 encoder, so the test does not depend on the same library the decoder would
 *  otherwise be checked against. */
function base58(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = bytes.reduce((acc, byte) => acc * 256n + BigInt(byte), 0n);
  let out = "";
  while (num > 0n) {
    out = ALPHABET[Number(num % 58n)] + out;
    num /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    out = `1${out}`;
  }
  return out;
}

const key = Keypair.generate();

describe("decodeRelayKeypair", () => {
  it("accepts base58, as documented in config.ts", () => {
    expect(decodeRelayKeypair(base58(key.secretKey)).publicKey.toBase58()).toBe(
      key.publicKey.toBase58(),
    );
  });

  it("accepts base64, as index.ts previously decoded", () => {
    // The doc said base58 and the code did base64. Both must work, or whichever half of the
    // repo an operator read from decides whether the deploy comes up.
    expect(
      decodeRelayKeypair(Buffer.from(key.secretKey).toString("base64")).publicKey.toBase58(),
    ).toBe(key.publicKey.toBase58());
  });

  it("accepts a solana-keygen JSON byte array", () => {
    expect(decodeRelayKeypair(JSON.stringify(Array.from(key.secretKey))).publicKey.toBase58()).toBe(
      key.publicKey.toBase58(),
    );
  });

  it("tolerates surrounding whitespace from a copied secret", () => {
    expect(decodeRelayKeypair(`  ${base58(key.secretKey)}\n`).publicKey.toBase58()).toBe(
      key.publicKey.toBase58(),
    );
  });

  it("preserves a leading zero byte", () => {
    // Base58 encodes leading zeros as '1' and a bigint decode drops them. A key with a
    // zero first byte would otherwise decode 63 bytes and be rejected as malformed.
    const secret = new Uint8Array(key.secretKey);
    let candidate = key;
    for (let i = 0; i < 200 && secret[0] !== 0; i++) {
      candidate = Keypair.generate();
      secret.set(candidate.secretKey);
    }
    if (secret[0] !== 0) return; // vanishingly unlikely; nothing to assert
    expect(decodeRelayKeypair(base58(secret)).publicKey.toBase58()).toBe(
      candidate.publicKey.toBase58(),
    );
  });

  it("rejects a public key pasted in place of the secret", () => {
    // 32 bytes, valid base58, and an easy paste error — it must not start a relay that then
    // fails on every signature.
    expect(() => decodeRelayKeypair(key.publicKey.toBase58())).toThrow(/64 bytes/);
  });

  it("rejects garbage without echoing it", () => {
    expect(() => decodeRelayKeypair("not-a-key")).toThrow(
      /RELAY_SOLANA_KEYPAIR is not a usable Solana secret key/,
    );
    try {
      decodeRelayKeypair("s3cr3t-looking-value");
    } catch (err) {
      expect((err as Error).message).not.toContain("s3cr3t");
    }
  });
});
