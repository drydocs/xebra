import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Solana delivery + proof convention (docs/architecture.md §4): the solver delivers via an
 * atomic transaction containing an idempotent ATA-create, the SPL transfer, and an SPL Memo
 * instruction carrying the intent hash — the direct structural analog of Stellar's
 * `memo_hash`-on-payment. Deliberately not a bespoke on-chain program: falsifiability comes
 * from the public transaction itself, verifiable by anyone via `getTransaction`, the same way
 * a Stellar fulfillment is verified against Horizon.
 *
 * If the solver only holds USDC on Solana (not `destAsset` directly), the Fill loop splices
 * Jupiter swap-route instructions in between the ATA-create and the transfer, in the same
 * atomic transaction — this module builds the direct-inventory-match case; composing in a
 * swap is the solver's Fill adapter's job (see docs/architecture.md §7).
 */

export const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

export interface BuildDeliveryInstructionsInput {
  /** Solver's own wallet — pays for the recipient's ATA rent and is the token source. */
  payer: PublicKey;
  /** `destAsset`'s SPL mint. */
  mint: PublicKey;
  /** `destAddress` — the end user's wallet, never touched/funded by them directly. */
  recipient: PublicKey;
  amount: bigint;
  decimals: number;
  /** The 32-byte intent hash — the same value bound into the source-chain escrow. */
  intentHash: Uint8Array;
}

export function buildDeliveryInstructions(
  input: BuildDeliveryInstructionsInput,
): TransactionInstruction[] {
  if (input.intentHash.length !== 32) {
    throw new Error(`intentHash must be 32 bytes, got ${input.intentHash.length}`);
  }

  const recipientAta = getAssociatedTokenAddressSync(input.mint, input.recipient);
  const payerAta = getAssociatedTokenAddressSync(input.mint, input.payer);

  const createAtaIx = createAssociatedTokenAccountIdempotentInstruction(
    input.payer,
    recipientAta,
    input.recipient,
    input.mint,
  );

  const transferIx = createTransferCheckedInstruction(
    payerAta,
    input.mint,
    recipientAta,
    input.payer,
    input.amount,
    input.decimals,
  );

  const memoIx = new TransactionInstruction({
    programId: MEMO_PROGRAM_ID,
    keys: [],
    data: Buffer.from(input.intentHash),
  });

  return [createAtaIx, transferIx, memoIx];
}

export function encodeMemoData(intentHash: Uint8Array): string {
  return bs58.encode(intentHash);
}
