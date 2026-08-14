import type { GetPublicKeyCommand, SignCommand } from "@aws-sdk/client-kms";
import { secp256k1 } from "@noble/curves/secp256k1";
import { createKmsEvmSigner } from "@xebra/arbiter-signer";
import type { KmsClientLike } from "@xebra/arbiter-signer";
import { parseTransaction, recoverTransactionAddress } from "viem";
import { describe, expect, it } from "vitest";
import { evmSignerToAccount } from "./evm-account.js";

/** Same fake-KMS pattern as packages/arbiter-signer's own tests: a real secp256k1 keypair
 *  stands in for a KMS key so this test exercises real signing math end-to-end, through the
 *  viem account adapter this file adds on top of @xebra/arbiter-signer. */
function buildFakeKms(privateKey: Uint8Array): KmsClientLike {
  const uncompressedPoint = secp256k1.getPublicKey(privateKey, false);
  const fakeSpkiPrefix = new Uint8Array(23).fill(0xaa);
  const fakePublicKeyDer = new Uint8Array([...fakeSpkiPrefix, ...uncompressedPoint]);

  return {
    async send(command: GetPublicKeyCommand | SignCommand): Promise<any> {
      if (command.constructor.name === "GetPublicKeyCommand") {
        return { PublicKey: fakePublicKeyDer };
      }
      const digest = (command as SignCommand).input.Message as Uint8Array;
      const sig = secp256k1.sign(digest, privateKey);
      return { Signature: sig.toDERRawBytes() };
    },
  };
}

describe("evmSignerToAccount", () => {
  it("produces a signTransaction result that recovers to the account's own address", async () => {
    const privateKey = secp256k1.utils.randomSecretKey();
    const kms = buildFakeKms(privateKey);
    const signer = await createKmsEvmSigner(kms, "test-key");
    const account = evmSignerToAccount(signer);

    expect(account.address).toBe(signer.address);

    const transaction = {
      chainId: 9001,
      to: "0x0000000000000000000000000000000000000001" as const,
      nonce: 0,
      gas: 100000n,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 1n,
      value: 0n,
      data: "0x" as const,
      type: "eip1559" as const,
    };

    const signedTx = await account.signTransaction(transaction);

    // parseTransaction + recoverTransactionAddress independently re-derive the signer from the
    // fully-serialized signed transaction — proves the whole round trip (serialize -> hash ->
    // KMS-sign -> reserialize with r/s/v) is internally consistent, using viem's own parsing
    // rather than re-deriving the hash by hand a second time.
    const parsed = parseTransaction(signedTx as `0x02${string}`);
    expect(parsed.r).toBeDefined();
    expect(parsed.s).toBeDefined();

    const recovered = await recoverTransactionAddress({
      serializedTransaction: signedTx as `0x02${string}`,
    });
    expect(recovered.toLowerCase()).toBe(signer.address.toLowerCase());
  });

  it("implements signMessage and signTypedData without throwing", async () => {
    const privateKey = secp256k1.utils.randomSecretKey();
    const kms = buildFakeKms(privateKey);
    const signer = await createKmsEvmSigner(kms, "test-key");
    const account = evmSignerToAccount(signer);

    const messageSig = await account.signMessage({ message: "hello" });
    expect(messageSig).toMatch(/^0x[0-9a-f]{130}$/);

    const typedDataSig = await account.signTypedData({
      domain: { name: "Xebra", version: "1", chainId: 9001 },
      types: { Ping: [{ name: "value", type: "uint256" }] },
      primaryType: "Ping",
      message: { value: 1n },
    });
    expect(typedDataSig).toMatch(/^0x[0-9a-f]{130}$/);
  });
});
