import { z } from "zod";

const ConfigSchema = z.object({
  SOLANA_RPC_URL: z.string().url(),
  /** Comma-separated base58 pubkeys — the solver wallet(s) whose activity is watched for
   *  deliveries. Solana has no escrow contract of its own to watch in v1 (destination-only),
   *  so unlike indexer-arc/-stellar this indexer polls known solver addresses rather than a
   *  single contract (see docs/architecture.md §4, §7). */
  SOLVER_ADDRESSES: z.string().min(1),
  POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  KAFKA_BROKERS: z.string().min(1),
});

export type IndexerSolanaConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerSolanaConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`indexer-solana: invalid configuration:\n${result.error.toString()}`);
  }
  return result.data;
}
