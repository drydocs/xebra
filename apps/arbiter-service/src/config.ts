import { z } from "zod";

const ConfigSchema = z.object({
  KAFKA_BROKERS: z.string().min(1),
  DATABASE_URL: z.string().min(1),

  ARC_RPC_URL: z.string().url(),
  ARC_ESCROW_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  ARBITER_EVM_KMS_KEY_ID: z.string().min(1),

  SOROBAN_RPC_URL: z.string().url(),
  STELLAR_ESCROW_CONTRACT_ID: z.string().min(1),
  STELLAR_NETWORK_PASSPHRASE: z.string().min(1),
  ARBITER_STELLAR_KMS_KEY_ID: z.string().min(1),

  /** Only used for verifying claims on the Stellar->Solana corridor (destination-chain proof
   *  fetch) — see verify-claim.ts. */
  SOLANA_RPC_URL: z.string().url(),
  /** Only used for verifying claims on the existing Arc->Stellar corridor (destination-chain
   *  proof fetch) — see verify-stellar-fulfillment.ts. */
  HORIZON_URL: z.string().url(),

  KMS_REGION: z.string().min(1).default("us-east-1"),
});

export type ArbiterServiceConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ArbiterServiceConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`arbiter-service: invalid configuration:\n${result.error.toString()}`);
  }
  return result.data;
}
