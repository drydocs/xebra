import {
  BASE_FEE,
  Contract,
  type Keypair,
  TransactionBuilder,
  nativeToScVal,
  type rpc,
} from "@stellar/stellar-sdk";
import type { ClaimAdapter, ClaimResult, FillResult } from "../fill-loop.js";

/**
 * Calls `claim` on the Stellar-source XebraEscrow Soroban contract (contracts/stellar-soroban),
 * asserting the solver's Solana delivery tx as the falsifiable proof (see that contract's
 * `claim` doc comment — it cannot and does not verify this itself; that's the challenge
 * mechanism's job). Real code, compiled against @stellar/stellar-sdk's actual API
 * (`Contract.call`, `rpc.Server.prepareTransaction`/`sendTransaction`, `TransactionBuilder`),
 * but — like the Soroban event-decoding in packages/chain-adapters — not exercised against a
 * live Soroban RPC in this codebase (no local Soroban network was available to deploy against;
 * see docs/architecture.md's "verify at build time" note).
 */
export function createStellarClaimAdapter(
  server: rpc.Server,
  escrowContractId: string,
  solverKeypair: Keypair,
  networkPassphrase: string,
): ClaimAdapter {
  return {
    async claim(intentHash: string, fill: FillResult): Promise<ClaimResult> {
      const contract = new Contract(escrowContractId);
      const account = await server.getAccount(solverKeypair.publicKey());

      const op = contract.call(
        "claim",
        nativeToScVal(Buffer.from(intentHash.replace(/^0x/, ""), "hex"), { type: "bytes" }),
        nativeToScVal(solverKeypair.publicKey(), { type: "address" }),
        nativeToScVal(Buffer.from(fill.destTxRef), { type: "bytes" }),
        nativeToScVal(fill.deliveredAmount, { type: "i128" }),
      );

      const tx = new TransactionBuilder(account, { fee: BASE_FEE, networkPassphrase })
        .addOperation(op)
        .setTimeout(30)
        .build();

      const prepared = await server.prepareTransaction(tx);
      prepared.sign(solverKeypair);

      const result = await server.sendTransaction(prepared);
      if (result.status === "ERROR") {
        throw new Error(`claim tx submission failed: ${JSON.stringify(result.errorResult)}`);
      }

      return { claimTxRef: result.hash };
    },
  };
}
