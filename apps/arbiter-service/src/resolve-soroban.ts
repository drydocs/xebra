import {
  BASE_FEE,
  Contract,
  type Transaction,
  TransactionBuilder,
  nativeToScVal,
  type rpc,
} from "@stellar/stellar-sdk";
import type { StellarSigner } from "@xebra/arbiter-signer";

/**
 * Submits `resolve(intent_hash, claim_valid)` on the Stellar-source XebraEscrow, signed via a
 * KMS-backed arbiter key. Structurally mirrors apps/solver's `stellar-claim.ts` (build with
 * `Contract.call`, `prepareTransaction`, sign, `sendTransaction`) but the signature itself comes
 * from `StellarSigner.sign` (KMS) instead of a local `Keypair` — Stellar transaction signing is
 * "sign the transaction's hash," which is exactly what `StellarSigner` provides, so the
 * signature is added directly as a decorated signature rather than via `Keypair.sign`.
 */
export async function resolveOnSoroban(
  server: rpc.Server,
  escrowContractId: string,
  signer: StellarSigner,
  networkPassphrase: string,
  intentHash: string,
  claimValid: boolean,
): Promise<{ txHash: string }> {
  const contract = new Contract(escrowContractId);
  const account = await server.getAccount(signer.publicKey);

  const op = contract.call(
    "resolve",
    nativeToScVal(Buffer.from(intentHash.replace(/^0x/, ""), "hex"), { type: "bytes" }),
    nativeToScVal(claimValid, { type: "bool" }),
  );

  const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
    .addOperation(op)
    .setTimeout(30)
    .build();

  const prepared = await server.prepareTransaction(tx);
  const txHash = prepared.hash();
  const signature = await signer.sign(txHash);

  prepared.addSignature(signer.publicKey, Buffer.from(signature).toString("base64"));

  const result = await server.sendTransaction(prepared as Transaction);
  if (result.status === "ERROR") {
    throw new Error(`resolve() submission failed: ${JSON.stringify(result.errorResult)}`);
  }

  return { txHash: result.hash };
}
