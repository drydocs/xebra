/**
 * @xebra/cctp-relay — gas-sponsoring relay for the CCTP-direct rail (docs/architecture.md §5):
 * watches Stellar burns, polls Circle's Iris attestation, submits `receiveMessage` on Solana
 * paying SOL gas from this service's own hot wallet.
 *
 * Bootstraps the real dependencies (Redis, Solana RPC, Iris HTTP client) and starts the BullMQ
 * worker. The actual pipeline logic lives in process-job.ts/schedule.ts (unit-tested, no live
 * network needed); this file's only job is wiring real infrastructure to that logic.
 *
 * The `receiveMessage` account layout is now implemented in `receive-message.ts`, built from
 * CCTP V2's IDLs and program source and simulated against Circle's live mainnet programs.
 *
 * STILL A PLACEHOLDER: `RelayJobStore` needs a real Postgres-backed implementation from
 * packages/db; this uses `InMemoryRelayJobStore`, so a restart loses in-flight jobs.
 */

import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { createIrisClient } from "@xebra/cctp-client";
import { registerPolledGauge, startObservability } from "@xebra/observability";
import pino from "pino";
import { loadConfig } from "./config.js";
import { InMemoryRelayJobStore } from "./job-store.js";
import { createSolanaMintSubmitter } from "./solana-mint-submitter.js";
import { startWorker } from "./worker.js";

const logger = pino({ name: "cctp-relay" });

async function main() {
  const config = loadConfig();
  const obs = startObservability({ serviceName: "cctp-relay" });

  const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
  const payer = Keypair.fromSecretKey(Buffer.from(config.RELAY_SOLANA_KEYPAIR, "base64"));
  const iris = createIrisClient(config.IRIS_BASE_URL);

  // docs/architecture.md §11's "relay SOL balance low" alert: sampled on every metric export
  // cycle rather than pushed, so a stalled relay's balance is still visible in Grafana.
  registerPolledGauge(
    obs.meter,
    "relay_sol_balance_lamports",
    { description: "The relay hot wallet's SOL balance, in lamports." },
    async () => connection.getBalance(payer.publicKey),
  );

  // Real, not a stub. The instruction it builds was simulated against Circle's live mainnet
  // programs; every PDA it derives was confirmed to exist on chain.
  const mint = createSolanaMintSubmitter(
    connection,
    payer,
    new PublicKey(config.SOLANA_USDC_ADDRESS),
    config.STELLAR_CCTP_DOMAIN_ID,
  );

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
    meter: obs.meter,
  });

  logger.info({ solanaRpc: config.SOLANA_RPC_URL }, "cctp-relay: worker started");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      logger.info({ signal }, "cctp-relay: shutting down");
      await worker.close();
      await obs.shutdown();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.error({ err }, "cctp-relay: fatal startup error");
  process.exit(1);
});
