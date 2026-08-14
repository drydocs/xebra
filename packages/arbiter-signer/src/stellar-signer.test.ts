import type { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { ed25519 } from "@noble/curves/ed25519";
import { StrKey } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import type { KmsClientLike } from "./kms-client.js";
import { createKmsStellarSigner } from "./stellar-signer.js";

/**
 * Same approach as evm-signer.test.ts: a genuine Ed25519 keypair via @noble/curves stands in
 * for a KMS key, producing real signatures/public-key material rather than stubbed responses.
 */
function buildFakeEd25519Kms(privateKey: Uint8Array): { kms: KmsClientLike; publicKey: string } {
  const rawPublicKey = ed25519.getPublicKey(privateKey);
  const publicKey = StrKey.encodeEd25519PublicKey(Buffer.from(rawPublicKey));

  const fakeSpkiPrefix = new Uint8Array(12).fill(0xbb);
  const fakePublicKeyDer = new Uint8Array([...fakeSpkiPrefix, ...rawPublicKey]);

  const kms: KmsClientLike = {
    async send(command: GetPublicKeyCommand | SignCommand): Promise<any> {
      if (command.constructor.name === "GetPublicKeyCommand") {
        return { PublicKey: fakePublicKeyDer };
      }
      const message = (command as SignCommand).input.Message as Uint8Array;
      return { Signature: ed25519.sign(message, privateKey) };
    },
  };

  return { kms, publicKey };
}

describe("createKmsStellarSigner", () => {
  it("derives the correct StrKey public address from the KMS key", async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    const { kms, publicKey } = buildFakeEd25519Kms(privateKey);

    const signer = await createKmsStellarSigner(kms, "test-key");

    expect(signer.publicKey).toBe(publicKey);
    expect(signer.publicKey.startsWith("G")).toBe(true);
  });

  it("produces a signature that verifies against the signer's own public key", async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    const { kms, publicKey } = buildFakeEd25519Kms(privateKey);
    const signer = await createKmsStellarSigner(kms, "test-key");

    const payload = new Uint8Array(32).fill(7); // stand-in for a transaction hash
    const signature = await signer.sign(payload);

    expect(signature).toHaveLength(64);

    const rawPublicKey = StrKey.decodeEd25519PublicKey(publicKey);
    const valid = ed25519.verify(signature, payload, new Uint8Array(rawPublicKey));
    expect(valid).toBe(true);
  });

  it("rejects a KMS response with a malformed signature length", async () => {
    const privateKey = ed25519.utils.randomSecretKey();
    const rawPublicKey = ed25519.getPublicKey(privateKey);
    const fakePublicKeyDer = new Uint8Array([...new Uint8Array(12).fill(0xbb), ...rawPublicKey]);

    const kms: KmsClientLike = {
      async send(command: GetPublicKeyCommand | SignCommand): Promise<any> {
        if (command.constructor.name === "GetPublicKeyCommand") {
          return { PublicKey: fakePublicKeyDer };
        }
        return { Signature: new Uint8Array(63) }; // one byte short
      },
    };
    const signer = await createKmsStellarSigner(kms, "test-key");

    await expect(signer.sign(new Uint8Array(32))).rejects.toThrow(/64-byte/);
  });
});
