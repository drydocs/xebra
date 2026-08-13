import { z } from "zod";

/**
 * Every CCTP domain/program address is required config, not a hardcoded constant — see the
 * module doc comment in packages/cctp-client/src/types.ts for why. Fails loudly at startup if
 * anything is missing rather than silently misrouting funds later.
 */
const ConfigSchema = z.object({
  REDIS_URL: z.string().url(),
  IRIS_BASE_URL: z.string().url(),

  STELLAR_CCTP_DOMAIN_ID: z.coerce.number().int().nonnegative(),
  STELLAR_TOKEN_MESSENGER_ADDRESS: z.string().min(1),
  STELLAR_MESSAGE_TRANSMITTER_ADDRESS: z.string().min(1),
  STELLAR_USDC_ADDRESS: z.string().min(1),

  SOLANA_CCTP_DOMAIN_ID: z.coerce.number().int().nonnegative(),
  SOLANA_TOKEN_MESSENGER_ADDRESS: z.string().min(1),
  SOLANA_MESSAGE_TRANSMITTER_ADDRESS: z.string().min(1),
  SOLANA_USDC_ADDRESS: z.string().min(1),
  SOLANA_RPC_URL: z.string().url(),

  /** Base58 secret key for the relay's gas-sponsoring hot wallet. Production: sourced from
   *  Secrets Manager, not a plain env var — see docs/architecture.md §11. */
  RELAY_SOLANA_KEYPAIR: z.string().min(1),

  RELAY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  RELAY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
});

export type RelayConfig = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayConfig {
  const result = ConfigSchema.safeParse(env);
  if (!result.success) {
    throw new Error(`cctp-relay: invalid configuration:\n${result.error.toString()}`);
  }
  return result.data;
}

export function toEnvironmentConfig(config: RelayConfig) {
  return {
    irisBaseUrl: config.IRIS_BASE_URL,
    stellar: {
      domainId: config.STELLAR_CCTP_DOMAIN_ID,
      tokenMessengerAddress: config.STELLAR_TOKEN_MESSENGER_ADDRESS,
      messageTransmitterAddress: config.STELLAR_MESSAGE_TRANSMITTER_ADDRESS,
      usdcAddress: config.STELLAR_USDC_ADDRESS,
    },
    solana: {
      domainId: config.SOLANA_CCTP_DOMAIN_ID,
      tokenMessengerAddress: config.SOLANA_TOKEN_MESSENGER_ADDRESS,
      messageTransmitterAddress: config.SOLANA_MESSAGE_TRANSMITTER_ADDRESS,
      usdcAddress: config.SOLANA_USDC_ADDRESS,
    },
  };
}
