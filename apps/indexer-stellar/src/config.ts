import { z } from "zod";

const ConfigSchema = z.object({
  SOROBAN_RPC_URL: z.string().url(),
  HORIZON_URL: z.string().url(),
  /** Stellar-source XebraEscrow contract id (C...), for the new Stellar->Solana corridor. */
  SOROBAN_ESCROW_CONTRACT_ID: z.string().min(1),
  /** Ledger to start polling from on first run (no cursor yet) — Soroban RPC's getEvents
   *  requires either a cursor or a startLedger, and Horizon-style "just start from latest"
   *  isn't available, so operators set this to the contract's deploy ledger. */
  SOROBAN_START_LEDGER: z.coerce.number().int().positive(),
  /** Fulfillment destination address to watch payments to, for the existing Arc->Stellar
   *  corridor (v1 spec) — solvers pay `destAddress` directly, there's no escrow contract on
   *  the Stellar destination side to subscribe to. */
  FULFILLMENT_WATCH_ADDRESSES: z.string().min(1),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  KAFKA_BROKERS: z.string().min(1),
});

export type IndexerStellarConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerStellarConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`indexer-stellar: invalid configuration:\n${result.error.toString()}`);
  }
  return result.data;
}
