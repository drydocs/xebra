import { z } from "zod";

const ConfigSchema = z.object({
  ARC_RPC_URL: z.string().url(),
  ARC_ESCROW_ADDRESS: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  ARC_CHAIN_ID: z.coerce.number().int().positive(),
  KAFKA_BROKERS: z.string().min(1), // comma-separated
});

export type IndexerArcConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): IndexerArcConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`indexer-arc: invalid configuration:\n${result.error.toString()}`);
  }
  return result.data;
}
