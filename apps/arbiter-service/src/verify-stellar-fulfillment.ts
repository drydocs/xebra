import type { Horizon } from "@stellar/stellar-sdk";
import { decodeFulfillmentPayment } from "@xebra/chain-adapters";
import {
  type ChainAddress,
  chainAddressToStellarAddress,
  nativeXlmAssetRef,
  stellarClassicAssetRef,
} from "@xebra/intent-schema";
import type { ClaimLookup } from "./lookup-claim.js";
import type { VerifyClaimResult } from "./verify-claim.js";

export interface StellarFulfillmentSource {
  getTransaction(hash: string): Promise<Horizon.ServerApi.TransactionRecord>;
  getPaymentsForTransaction(
    hash: string,
  ): Promise<
    Array<Horizon.ServerApi.PaymentOperationRecord | Horizon.ServerApi.PathPaymentOperationRecord>
  >;
}

/**
 * Verifies a claim on the existing (frozen) Arc->Stellar corridor: does a real Stellar payment
 * satisfy the intent's expected recipient/asset/amount, with its transaction memo bound to this
 * intent hash? Mirrors verify-claim.ts's Solana path but for Horizon.
 *
 * The asset check doesn't need a reverse lookup from `destAssetId`'s one-way hash back to an
 * asset code/issuer (there is no such registry, and `sha256(assetCode||issuer)` can't be
 * inverted) — instead it hashes the ACTUAL payment's asset the same way the intent's hash was
 * produced (`stellarClassicAssetRef`) and compares hashes. Same shape as the Solana path
 * comparing a transfer's mint against an expected mint, just via a hash instead of a plain
 * pubkey equality check.
 */
export async function verifyStellarFulfillment(
  source: StellarFulfillmentSource,
  { intent, claim }: ClaimLookup,
): Promise<VerifyClaimResult> {
  const tx = await source.getTransaction(claim.destTxRef).catch(() => null);
  if (!tx) return { ok: true, verified: false, reason: "destination tx not found" };

  const payments = await source.getPaymentsForTransaction(claim.destTxRef);
  const expectedRecipient = chainAddressToStellarAddress(intent.destAddress as ChainAddress);
  const expectedAssetId = intent.destAssetId.toLowerCase();

  for (const payment of payments) {
    const event = decodeFulfillmentPayment(payment, tx);
    if (!event || event.intentHash?.toLowerCase() !== intent.intentHash.toLowerCase()) continue;
    if (payment.to !== expectedRecipient) continue;

    const actualAssetId =
      payment.asset_type === "native"
        ? nativeXlmAssetRef().assetId
        : stellarClassicAssetRef(
            "asset_code" in payment ? (payment.asset_code ?? "") : "",
            "asset_issuer" in payment ? (payment.asset_issuer ?? "") : "",
          ).assetId;
    if (actualAssetId.toLowerCase() !== expectedAssetId) continue;

    const deliveredStroops = stellarAmountToStroops(payment.amount);
    if (deliveredStroops < BigInt(intent.minDestAmount)) {
      return {
        ok: true,
        verified: false,
        reason: `delivered amount ${deliveredStroops} is below the required minimum ${intent.minDestAmount}`,
      };
    }

    return { ok: true, verified: true };
  }

  return {
    ok: true,
    verified: false,
    reason: "no payment in this transaction satisfies the intent",
  };
}

/** Horizon amount strings are always 7-decimal fixed point (e.g. "50.0000000") — parsed as a
 *  string, not a float, to avoid precision loss on large amounts. */
export function stellarAmountToStroops(amount: string): bigint {
  const [whole = "0", frac = ""] = amount.split(".");
  const paddedFrac = frac.padEnd(7, "0").slice(0, 7);
  return BigInt(whole) * 10_000_000n + BigInt(paddedFrac || "0");
}
