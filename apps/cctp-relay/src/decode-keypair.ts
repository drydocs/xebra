import { Keypair } from "@solana/web3.js";

/**
 * Decodes the relay's hot-wallet secret key from whichever encoding the operator supplied.
 *
 * # The bug this closes
 *
 * `config.ts` documented `RELAY_SOLANA_KEYPAIR` as **base58** while `index.ts` decoded it as
 * **base64**. Anyone populating that secret from the doc comment got a wallet the relay could
 * not use — and base64's decoder does not reject base58 input, it just produces different
 * bytes, so the failure surfaced as an unrelated "invalid secret key" at startup rather than
 * as an encoding error.
 *
 * Rather than pick a side and leave the other silently broken, all three real encodings are
 * accepted and validated: base58 (what `solana-keygen` and Phantom export), base64, and the
 * JSON byte array that `solana-keygen new` writes to a file. Every candidate must produce a
 * key `Keypair.fromSecretKey` accepts, so a mis-decode cannot become a wallet that signs with
 * the wrong key.
 *
 * The error is deliberately shaped to say what was tried without echoing any of the input: an
 * error message containing part of a decoded secret key ends up in logs.
 */

function fromJsonArray(value: string): Uint8Array | undefined {
  if (!value.trimStart().startsWith("[")) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed) || !parsed.every((n) => typeof n === "number")) return undefined;
    return Uint8Array.from(parsed as number[]);
  } catch {
    return undefined;
  }
}

function fromBase64(value: string): Uint8Array | undefined {
  // Node's base64 decoder ignores characters outside the alphabet instead of failing, so the
  // length check below is what actually rejects a base58 string handed to this branch.
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 64 ? new Uint8Array(bytes) : undefined;
}

function fromBase58(value: string): Uint8Array | undefined {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = 0n;
  for (const char of value) {
    const index = ALPHABET.indexOf(char);
    if (index === -1) return undefined;
    num = num * 58n + BigInt(index);
  }

  const bytes: number[] = [];
  while (num > 0n) {
    bytes.unshift(Number(num % 256n));
    num /= 256n;
  }
  // Base58 encodes each leading zero byte as '1'; those bytes are lost by the bigint above and
  // have to be restored, or a key with a leading zero decodes one byte short.
  for (const char of value) {
    if (char !== "1") break;
    bytes.unshift(0);
  }

  return bytes.length === 64 ? Uint8Array.from(bytes) : undefined;
}

export function decodeRelayKeypair(value: string): Keypair {
  const trimmed = value.trim();

  for (const decode of [fromJsonArray, fromBase64, fromBase58]) {
    const bytes = decode(trimmed);
    if (!bytes) continue;
    try {
      return Keypair.fromSecretKey(bytes);
    } catch {
      // Right length, wrong bytes — keep trying the other encodings rather than concluding
      // the key is bad, since a base58 string can decode to 64 base64 bytes by coincidence.
    }
  }

  throw new Error(
    "RELAY_SOLANA_KEYPAIR is not a usable Solana secret key. Accepted: base58 (as exported by " +
      "solana-keygen or Phantom), base64, or the JSON byte array in a solana-keygen keyfile. " +
      "It must decode to 64 bytes.",
  );
}
