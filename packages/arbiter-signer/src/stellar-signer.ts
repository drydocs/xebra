import { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { StrKey } from "@stellar/stellar-sdk";
import { extractEd25519PublicKeyFromSpki } from "./der.js";
import type { KmsClientLike } from "./kms-client.js";

/**
 * KMS-backed Stellar (Ed25519) signer for the v1 arbiter's `resolve()` calls on the Stellar-
 * source XebraEscrow (contracts/stellar-soroban), authorized via `require_auth`. Considerably
 * simpler than the EVM signer: Ed25519 signatures have no recovery-bit ambiguity and KMS
 * returns the raw 64-byte (R, S) signature directly — no DER decoding needed for the signature
 * itself (only the GetPublicKey response is DER-wrapped).
 *
 * `SigningAlgorithm: ED25519_SHA_512` with `MessageType: RAW` is the correct pairing here even
 * though the message is already a 32-byte transaction hash: Ed25519 always internally hashes
 * whatever it's given as part of the algorithm itself (unlike ECDSA's optional external
 * pre-hash), so signing a hash "raw" through Ed25519 is standard practice, not a mismatch with
 * KMS's DIGEST mode (which is specifically for algorithms like ECDSA that support skipping
 * their internal hash step — Ed25519 has no such mode to skip). This resolves
 * docs/architecture.md's "verify at build time" note on KMS's Ed25519 message-type wiring.
 */
export interface StellarSigner {
  publicKey: string;
  sign(payload: Uint8Array): Promise<Uint8Array>;
}

export async function createKmsStellarSigner(
  kms: KmsClientLike,
  keyId: string,
): Promise<StellarSigner> {
  const publicKeyResponse = await kms.send(new GetPublicKeyCommand({ KeyId: keyId }));
  if (!publicKeyResponse.PublicKey) {
    throw new Error(`createKmsStellarSigner: GetPublicKey returned no PublicKey for ${keyId}`);
  }
  const rawPublicKey = extractEd25519PublicKeyFromSpki(publicKeyResponse.PublicKey);
  const publicKey = StrKey.encodeEd25519PublicKey(Buffer.from(rawPublicKey));

  return {
    publicKey,
    async sign(payload) {
      const signResponse = await kms.send(
        new SignCommand({
          KeyId: keyId,
          Message: payload,
          MessageType: "RAW",
          SigningAlgorithm: "ED25519_SHA_512",
        }),
      );
      if (!signResponse.Signature) {
        throw new Error("sign: KMS Sign returned no Signature");
      }
      if (signResponse.Signature.length !== 64) {
        throw new Error(
          `sign: expected a 64-byte Ed25519 signature, got ${signResponse.Signature.length} bytes`,
        );
      }
      return signResponse.Signature;
    },
  };
}
