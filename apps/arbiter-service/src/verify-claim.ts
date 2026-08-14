import type { Connection } from "@solana/web3.js";
import { PublicKey } from "@solana/web3.js";
import { verifyDelivery } from "@xebra/chain-adapters";
import {
  AssetKind,
  type ChainAddress,
  ChainId,
  assetRefToSplMint,
  chainAddressToSolanaAddress,
  hex32ToBytes,
} from "@xebra/intent-schema";
import type { ClaimLookup } from "./lookup-claim.js";

export type VerifyClaimResult =
  | { ok: true; verified: boolean; reason?: string }
  | { ok: false; reason: string };

/**
 * Dispatches to the right destination-chain verification for a claim, then hands the caller a
 * plain pass/fail — `decide.ts`'s `decideClaimValidity` is the one-line wrapper around this
 * that turns it into the `claimValid` bool `resolve()` needs. v1 scope: only the Solana
 * destination (this session's new Stellar->Solana corridor) is wired; the existing Arc->Stellar
 * corridor's Horizon-based fulfillment-payment match check is real, documented follow-on work
 * (its decode half already exists in @xebra/chain-adapters' `decodeFulfillmentPayment`, but the
 * "does this payment satisfy this specific claim" comparison isn't written yet) — `ok: false`
 * below for that case is a "can't verify yet," not a claim-is-invalid verdict, and callers must
 * not resolve a challenge on it.
 */
export async function verifyClaimAgainstDestinationChain(
  solanaConnection: Connection,
  { intent, claim }: ClaimLookup,
): Promise<VerifyClaimResult> {
  // `intents` has no standalone destChain column — the destination chain lives on
  // `destAddress.chainId` (see packages/db/src/schema.ts; project-intent-opened.ts sets it when
  // the row is first projected).
  const destChain = (intent.destAddress as ChainAddress).chainId;
  if (destChain !== ChainId.Solana) {
    return {
      ok: false,
      reason: `destination chain ${destChain} verification isn't wired yet (only Solana is)`,
    };
  }

  const tx = await solanaConnection.getParsedTransaction(claim.destTxRef, {
    maxSupportedTransactionVersion: 0,
  });
  if (!tx) {
    return { ok: true, verified: false, reason: "destination tx not found" };
  }

  const mint = new PublicKey(
    assetRefToSplMint({
      chainId: ChainId.Solana,
      kind: AssetKind.SplToken,
      assetId: intent.destAssetId as `0x${string}`,
    }),
  );
  const recipient = new PublicKey(chainAddressToSolanaAddress(intent.destAddress as ChainAddress));

  const result = verifyDelivery({
    tx,
    intentHash: hex32ToBytes(intent.intentHash as `0x${string}`),
    mint,
    minAmount: BigInt(intent.minDestAmount),
    recipient,
  });

  return result.ok
    ? { ok: true, verified: true }
    : { ok: true, verified: false, reason: result.reason };
}
