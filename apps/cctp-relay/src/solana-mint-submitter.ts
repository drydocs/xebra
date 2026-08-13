import {
  type Connection,
  type Keypair,
  Transaction,
  type TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import type { MintSubmitter } from "@xebra/cctp-client";

/**
 * Builds the actual `receiveMessage` instruction for CCTP V2's Solana `MessageTransmitterV2`
 * program. Deliberately an injected function rather than inlined here: correct account
 * ordering/PDAs for that instruction come from Circle's own `solana-cctp-contracts` SDK/IDL,
 * which this package does not vendor (see docs/architecture.md's "verify at build time" note
 * on CCTP V2 Solana program IDs before relying on any specific instruction layout). Wire a real
 * implementation of this against that SDK before running the relay against a live network —
 * everything else in this file (signing, sending, confirming, gas accounting) is real.
 */
export type ReceiveMessageInstructionBuilder = (params: {
  message: `0x${string}`;
  attestation: `0x${string}`;
  payer: Keypair;
}) => Promise<TransactionInstruction[]>;

export function createSolanaMintSubmitter(
  connection: Connection,
  payer: Keypair,
  buildInstructions: ReceiveMessageInstructionBuilder,
): MintSubmitter {
  return {
    async submitReceiveMessage(message, attestation) {
      const instructions = await buildInstructions({ message, attestation, payer });
      const tx = new Transaction().add(...instructions);
      const signature = await sendAndConfirmTransaction(connection, tx, [payer], {
        commitment: "confirmed",
      });
      return { signature };
    },
  };
}
