import type { EvmSigner } from "@xebra/arbiter-signer";
import { XEBRA_ESCROW_ABI } from "@xebra/chain-adapters";
import { http, type Hex, createPublicClient, createWalletClient } from "viem";
import { evmSignerToAccount } from "./evm-account.js";

/** Submits `resolve(intentHash, claimValid)` on the Arc XebraEscrow, signed via a KMS-backed
 *  arbiter key. See docs/architecture.md §8 and evm-account.ts. */
export async function resolveOnArc(
  rpcUrl: string,
  escrowAddress: Hex,
  signer: EvmSigner,
  intentHash: Hex,
  claimValid: boolean,
): Promise<{ txHash: Hex }> {
  const account = evmSignerToAccount(signer);
  const transport = http(rpcUrl);
  const publicClient = createPublicClient({ transport });
  const walletClient = createWalletClient({ account, transport });

  const { request } = await publicClient.simulateContract({
    account,
    address: escrowAddress,
    abi: XEBRA_ESCROW_ABI,
    functionName: "resolve",
    args: [intentHash, claimValid],
  });
  const txHash = await walletClient.writeContract(request);

  return { txHash };
}
