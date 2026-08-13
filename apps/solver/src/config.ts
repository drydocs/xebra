import { z } from "zod";

const ConfigSchema = z.object({
  KAFKA_BROKERS: z.string().min(1),
  SOLANA_RPC_URL: z.string().url(),
  SOROBAN_RPC_URL: z.string().url(),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1),
  STELLAR_ESCROW_CONTRACT_ID: z.string().min(1),
  /** Base64-encoded raw Solana secret key. */
  SOLVER_SOLANA_KEYPAIR: z.string().min(1),
  /** Stellar secret seed (S...). */
  SOLVER_STELLAR_SECRET: z.string().min(1),
});

export type SolverConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): SolverConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`solver: invalid configuration:\n${result.error.toString()}`);
  }
  return result.data;
}
