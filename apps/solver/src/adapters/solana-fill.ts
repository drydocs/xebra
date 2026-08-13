import { getMint } from "@solana/spl-token";
import {
  type Connection,
  type Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { buildDeliveryInstructions } from "@xebra/chain-adapters";
import {
  ChainId,
  type IntentV2,
  assetRefToSplMint,
  chainAddressToSolanaAddress,
  hex32ToBytes,
} from "@xebra/intent-schema";
import type { FillAdapter, FillResult } from "../fill-loop.js";

/**
 * v1 Solana fill adapter: direct-inventory-match only (delivers `destAsset` straight from the
 * solver's own holdings). Jupiter swap-route splicing for the "solver only holds USDC on
 * Solana" case is intentionally not implemented here yet — see the module doc comment on
 * `buildDeliveryInstructions` in packages/chain-adapters for exactly where that would be
 * inserted; the ATA-create + transfer + memo instruction sequence this adapter builds is
 * unchanged either way, only the instructions spliced in before the transfer differ.
 */
export interface InventoryChecker {
  getBalance(mint: PublicKey): Promise<bigint>;
}

export function createSolanaFillAdapter(
  connection: Connection,
  solverKeypair: Keypair,
  inventory: InventoryChecker,
): FillAdapter {
  return {
    async quote(intent: IntentV2) {
      if (intent.destChain !== ChainId.Solana) {
        return { canFill: false, deliveredAmount: 0n, reason: "not a Solana-destination intent" };
      }

      const mint = new PublicKey(assetRefToSplMint(intent.destAsset));
      const balance = await inventory.getBalance(mint);

      if (balance < intent.minDestAmount) {
        return {
          canFill: false,
          deliveredAmount: 0n,
          reason: `insufficient inventory: have ${balance}, need ${intent.minDestAmount}`,
        };
      }

      return { canFill: true, deliveredAmount: intent.minDestAmount };
    },

    async fill(intent: IntentV2, intentHash: string): Promise<FillResult> {
      const mint = new PublicKey(assetRefToSplMint(intent.destAsset));
      const recipient = new PublicKey(chainAddressToSolanaAddress(intent.destAddress));
      const mintInfo = await getMint(connection, mint);

      const instructions = buildDeliveryInstructions({
        payer: solverKeypair.publicKey,
        mint,
        recipient,
        amount: intent.minDestAmount,
        decimals: mintInfo.decimals,
        intentHash: hex32ToBytes(intentHash as `0x${string}`),
      });

      const tx = new Transaction().add(...instructions);
      const signature = await sendAndConfirmTransaction(connection, tx, [solverKeypair], {
        commitment: "confirmed",
      });

      return { destTxRef: signature, deliveredAmount: intent.minDestAmount };
    },
  };
}
