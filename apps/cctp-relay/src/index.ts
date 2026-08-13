/**
 * @xebra/cctp-relay — gas-sponsoring relay for the CCTP-direct rail (docs/architecture.md §5):
 * watches Stellar burns, polls Circle's Iris attestation, submits `receiveMessage` on Solana
 * paying SOL gas from this service's own hot wallet.
 *
 * Bootstraps the real dependencies (Redis, Solana RPC, Iris HTTP client) and starts the BullMQ
 * worker. The actual pipeline logic lives in process-job.ts/schedule.ts (unit-tested, no live
 * network needed); this file's only job is wiring real infrastructure to that logic.
 *
 * NOT YET WIRED: `buildReceiveMessageInstruction` (see solana-mint-submitter.ts) needs Circle's
 * actual solana-cctp-contracts SDK/IDL for the CCTP V2 `receiveMessage` account layout — verify
 * current program IDs and instruction shape before pointing this at a live network (see
 * docs/architecture.md's "verify at build time" note). `RelayJobStore` similarly needs a real
 * Postgres-backed implementation from packages/db once that package lands (task 5); this uses
 * `InMemoryRelayJobStore` as a placeholder so the service is runnable end-to-end today.
 */

import { Connection, Keypair } from "@solana/web3.js";
import { createIrisClient } from "@xebra/cctp-client";
import pino from "pino";
import { loadConfig } from "./config.js";
import { InMemoryRelayJobStore } from "./job-store.js";
import { createSolanaMintSubmitter } from "./solana-mint-submitter.js";
import { startWorker } from "./worker.js";

const logger = pino({ name: "cctp-relay" });

async function main() {
  const config = loadConfig();

  const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
  const payer = Keypair.fromSecretKey(Buffer.from(config.RELAY_SOLANA_KEYPAIR, "base64"));
  const iris = createIrisClient(config.IRIS_BASE_URL);

  const mint = createSolanaMintSubmitter(connection, payer, async () => {
    throw new Error(
      "buildReceiveMessageInstruction is not wired yet — see NOT YET WIRED note in " +
        "apps/cctp-relay/src/index.ts",
    );
  });

  const { worker } = startWorker({
    connection: { url: config.REDIS_URL },
    deps: {
      iris,
      mint,
      store: new InMemoryRelayJobStore(),
      pollIntervalMs: config.RELAY_POLL_INTERVAL_MS,
      maxAttempts: config.RELAY_MAX_ATTEMPTS,
    },
    logger,
  });

  logger.info({ solanaRpc: config.SOLANA_RPC_URL }, "cctp-relay: worker started");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      logger.info({ signal }, "cctp-relay: shutting down");
      await worker.close();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.error({ err }, "cctp-relay: fatal startup error");
  process.exit(1);
});
