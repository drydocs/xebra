import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { extractSecp256k1PublicKeyFromSpki } from "./der.js";
import type { KmsClientLike } from "./kms-client.js";

/**
 * KMS-backed EVM (secp256k1) signer for the v1 arbiter's `resolve()` calls on the Arc contract
 * (contracts/arc-evm/src/XebraEscrow.sol). The Arc contract verifies claims via
 * `ECDSA.recover(digest, signature)` against a plain Ethereum address — this signer's job is to
 * produce exactly that 65-byte (r, s, v) signature from a KMS `ECDSA_SHA_256` key, matching
 * what a local private key + `ethers`/`viem` would produce.
 *
 * KMS returns a DER-encoded (r, s) pair with no recovery bit (KMS has no concept of Ethereum's
 * v) — this signer recovers it itself by trying both candidates against the KMS key's own
 * public key (fetched once via GetPublicKey and cached), and normalizes s to low-S form
 * (EIP-2), since Arc's `ECDSA.recover` (OpenZeppelin) rejects high-S signatures as a
 * malleability guard.
 */
export interface EvmSigner {
  address: `0x${string}`;
  /** `digest` must already be the final 32-byte hash to sign (e.g. an EIP-712 digest) — this
   *  signer does not hash its input, matching KMS's `MessageType: DIGEST` mode. */
  signDigest(digest: Uint8Array): Promise<`0x${string}`>;
}

export async function createKmsEvmSigner(kms: KmsClientLike, keyId: string): Promise<EvmSigner> {
  const publicKeyResponse = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!publicKeyResponse.PublicKey) {
    throw new Error(`createKmsEvmSigner: GetPublicKey returned no PublicKey for ${keyId}`);
  }
  const uncompressedPoint = extractSecp256k1PublicKeyFromSpki(publicKeyResponse.PublicKey);
  const address = evmAddressFromUncompressedPoint(uncompressedPoint);

  return {
    address,
    async signDigest(digest) {
      if (digest.length !== 32) {
        throw new Error(`signDigest: expected a 32-byte digest, got ${digest.length} bytes`);
      }

      const signResponse = await kms.send(
        new SignCommand({
          KeyId: keyId,
          Message: digest,
          MessageType: "DIGEST",
          SigningAlgorithm: "ECDSA_SHA_256",
        }),
      );
      if (!signResponse.Signature) {
        throw new Error("signDigest: KMS Sign returned no Signature");
      }

      let sig = secp256k1.Signature.fromDER(signResponse.Signature);
      if (sig.hasHighS()) {
        sig = sig.normalizeS();
      }

      const recovery = findRecoveryBit(sig, digest, uncompressedPoint);
      const recovered = sig.addRecoveryBit(recovery);

      const r = recovered.r.toString(16).padStart(64, "0");
      const s = recovered.s.toString(16).padStart(64, "0");
      const v = (27 + recovery).toString(16).padStart(2, "0");
      return `0x${r}${s}${v}` as `0x${string}`;
    },
  };
}

function findRecoveryBit(
  sig: InstanceType<typeof secp256k1.Signature>,
  digest: Uint8Array,
  expectedPublicKey: Uint8Array,
): 0 | 1 {
  for (const recovery of [0, 1] as const) {
    const candidatePoint = sig.addRecoveryBit(recovery).recoverPublicKey(digest).toRawBytes(false);
    if (bytesEqual(candidatePoint, expectedPublicKey)) {
      return recovery;
    }
  }
  throw new Error(
    "findRecoveryBit: neither recovery bit (0 or 1) matched the KMS key's public key",
  );
}

function evmAddressFromUncompressedPoint(point: Uint8Array): `0x${string}` {
  const hash = keccak_256(point.slice(1)); // drop the leading 0x04 prefix byte
  const addressBytes = hash.slice(-20);
  let hex = "0x";
  for (const b of addressBytes) hex += b.toString(16).padStart(2, "0");
  return hex as `0x${string}`;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
