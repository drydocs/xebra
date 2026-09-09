import { type AssetRef, ChainId, solanaAddressToChainAddress } from "@xebra/intent-schema";
import type { OpenIntentParams } from "./open-intent.js";

/**
 * Pure amount/hex conversion logic extracted out of the page component so it's testable without
 * rendering React or touching a wallet. `sourceAmount` is entered in human units (USDC) and
 * converted to Stellar's 7-decimal fixed-point convention (see contracts/stellar-soroban's
 * module doc comment on decimals); `minDestAmount` applies a placeholder 2% slippage tolerance
 * until a real quote-derived minimum is wired up.
 */
export interface BuildParamsInput {
  escrowContractId: string;
  sorobanRpcUrl: string;
  networkPassphrase: string;
  sourceTokenAddress: string;
  userAddress: string;
  sourceAmountHuman: string;
  destAsset: AssetRef;
  destAddressBase58: string;
  nowUnixSeconds: number;
  nonce: bigint;
}

export function buildOpenIntentParams(input: BuildParamsInput): OpenIntentParams {
  const sourceAmountNumber = Number(input.sourceAmountHuman);
  if (!Number.isFinite(sourceAmountNumber) || sourceAmountNumber <= 0) {
    throw new Error(`invalid source amount: ${input.sourceAmountHuman}`);
  }

  const sourceAmount = BigInt(Math.round(sourceAmountNumber * 1e7));
  const minDestAmount = BigInt(Math.round(sourceAmountNumber * 0.98 * 1e9));

  return {
    escrowContractId: input.escrowContractId,
    sorobanRpcUrl: input.sorobanRpcUrl,
    networkPassphrase: input.networkPassphrase,
    userAddress: input.userAddress,
    sourceTokenAddress: input.sourceTokenAddress,
    sourceAmount,
    destChain: ChainId.Solana,
    destAssetHex: input.destAsset.assetId,
    minDestAmount,
    destAddressHex: solanaAddressToChainAddress(input.destAddressBase58).raw,
    expiry: BigInt(input.nowUnixSeconds + 3600),
    nonce: input.nonce,
  };
}
