import type { EvmSigner } from "@xebra/arbiter-signer";
import {
  type LocalAccount,
  hashMessage,
  hashTypedData,
  hexToBytes,
  keccak256,
  parseSignature,
  serializeTransaction,
} from "viem";
import { toAccount } from "viem/accounts";

/**
 * Adapts @xebra/arbiter-signer's `EvmSigner` (KMS-backed) into a viem `LocalAccount`, so
 * `apps/arbiter-service` can use it with a normal `WalletClient`/`writeContract` call exactly
 * like a local private-key account — the only difference is every signature round-trips
 * through KMS instead of an in-process key. `signTransaction` does the real work (that's what
 * `writeContract` calls); `signMessage`/`signTypedData` are implemented for interface
 * completeness but unused by `resolve()`, a plain contract call.
 */
export function evmSignerToAccount(signer: EvmSigner): LocalAccount {
  return toAccount({
    address: signer.address,
    async sign({ hash }) {
      return signer.signDigest(hexToBytes(hash));
    },
    async signMessage({ message }) {
      const hash = hashMessage(message);
      return signer.signDigest(hexToBytes(hash));
    },
    async signTransaction(transaction) {
      const unsigned = serializeTransaction(transaction);
      const hash = keccak256(unsigned);
      const signatureHex = await signer.signDigest(hexToBytes(hash));
      const signature = parseSignature(signatureHex);
      return serializeTransaction(transaction, signature);
    },
    async signTypedData(parameters) {
      const hash = hashTypedData(parameters);
      return signer.signDigest(hexToBytes(hash));
    },
  }) as LocalAccount;
}
