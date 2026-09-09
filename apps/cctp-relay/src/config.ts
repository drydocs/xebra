import { z } from "zod";

/**
 * Every CCTP domain/program address is required config, not a hardcoded constant — see the
 * module doc comment in packages/cctp-client/src/types.ts for why. Fails loudly at startup if
 * anything is missing rather than silently misrouting funds later.
 */
const ConfigSchema = z
  .object({
    REDIS_URL: z.string().url(),
    IRIS_BASE_URL: z.string().url(),
    /** Relay job state and the watcher cursor. Required: an in-memory store loses every
     *  in-flight transfer on restart, and an in-memory cursor silently skips burns once the
     *  RPC's event-retention window passes the configured start ledger. */
    DATABASE_URL: z.string().url(),

    STELLAR_CCTP_DOMAIN_ID: z.coerce.number().int().nonnegative(),
    STELLAR_TOKEN_MESSENGER_ADDRESS: z.string().min(1),
    STELLAR_MESSAGE_TRANSMITTER_ADDRESS: z.string().min(1),
    STELLAR_USDC_ADDRESS: z.string().min(1),

    SOLANA_CCTP_DOMAIN_ID: z.coerce.number().int().nonnegative(),
    SOLANA_TOKEN_MESSENGER_ADDRESS: z.string().min(1),
    SOLANA_MESSAGE_TRANSMITTER_ADDRESS: z.string().min(1),
    SOLANA_USDC_ADDRESS: z.string().min(1),
    SOLANA_RPC_URL: z.string().url(),

    /** Soroban RPC, for the burn watcher. */
    SOROBAN_RPC_URL: z.string().url(),
    /** The wrapper contract whose `bridge_initiated` events are burns we were paid for. Empty
     *  until it is deployed — the watcher then stays off and burns arrive by hash through
     *  `POST /burns` instead, which is the direct-mode path. */
    STELLAR_CCTP_WRAPPER_CONTRACT_ID: z.string().default(""),
    /** First-run bootstrap only; the persisted cursor takes over from the first saved batch. */
    SOROBAN_START_LEDGER: z.coerce.number().int().positive().optional(),
    BURN_SCAN_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),

    /** Secret key for the relay's gas-sponsoring hot wallet, in base58, base64, or the JSON byte
     *  array `solana-keygen` writes — `decodeRelayKeypair` accepts all three, because this
     *  comment and the code that read it used to disagree. Production: sourced from Secrets
     *  Manager, not a plain env var — see docs/architecture.md §11. */
    RELAY_SOLANA_KEYPAIR: z.string().min(1),

    /** Shared secret gating `POST /burns`. Not optional: minting costs this service 867,621
     *  lamports of permanent rent per transfer, so an unauthenticated endpoint is a funded
     *  drain that anyone on the internet can point at strangers' burns. */
    RELAY_SUBMIT_TOKEN: z.string().min(32),
    RELAY_HTTP_PORT: z.coerce.number().int().positive().default(8080),

    RELAY_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
    RELAY_MAX_ATTEMPTS: z.coerce.number().int().positive().default(10),
  })
  .refine((c) => !c.STELLAR_CCTP_WRAPPER_CONTRACT_ID || c.SOROBAN_START_LEDGER !== undefined, {
    message:
      "SOROBAN_START_LEDGER is required when STELLAR_CCTP_WRAPPER_CONTRACT_ID is set — the " +
      "watcher has no ledger to bootstrap from on its first run",
    path: ["SOROBAN_START_LEDGER"],
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
