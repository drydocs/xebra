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
import {
  type StellarFulfillmentSource,
  verifyStellarFulfillment,
} from "./verify-stellar-fulfillment.js";

export type VerifyClaimResult =
  | { ok: true; verified: boolean; reason?: string }
  | { ok: false; reason: string };

/**
 * Dispatches to the right destination-chain verification for a claim, then hands the caller a
 * plain pass/fail — `decide.ts`'s `decideClaimValidity` is the one-line wrapper around this
 * that turns it into the `claimValid` bool `resolve()` needs. Covers both corridors: the new
 * Stellar->Solana one (this session's build) and the existing Arc->Stellar one (see
 * verify-stellar-fulfillment.ts for that corridor's Horizon-based match check).
 */
export async function verifyClaimAgainstDestinationChain(
  solanaConnection: Connection,
  stellarSource: StellarFulfillmentSource,
  { intent, claim }: ClaimLookup,
): Promise<VerifyClaimResult> {
  // `intents` has no standalone destChain column — the destination chain lives on
  // `destAddress.chainId` (see packages/db/src/schema.ts; project-intent-opened.ts sets it when
  // the row is first projected).
  const destChain = (intent.destAddress as ChainAddress).chainId;

  if (destChain === ChainId.Stellar) {
    return verifyStellarFulfillment(stellarSource, { intent, claim });
  }
  if (destChain !== ChainId.Solana) {
    return {
      ok: false,
      reason: `destination chain ${destChain} verification isn't wired yet (only Solana and Stellar are)`,
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
