/**
 * @xebra/cctp-relay — gas-sponsoring relay for the CCTP-direct rail (docs/architecture.md §5):
 * watches Stellar burns, polls Circle's Iris attestation, submits `receiveMessage` on Solana
 * paying SOL gas from this service's own hot wallet.
 *
 * Bootstraps the real dependencies (Postgres, Redis, Soroban RPC, Solana RPC, Iris) and starts
 * three things: the BullMQ worker that drives jobs to a mint, the burn watcher that creates
 * those jobs from wrapper events, and an HTTP endpoint that accepts a burn by hash.
 *
 * The pipeline logic itself lives in process-job.ts / schedule.ts / burn-watcher.ts, all
 * unit-tested without a network. This file only wires infrastructure to it.
 *
 * # Why two ways in
 *
 * The watcher keys off `bridge_initiated`, emitted by our wrapper contract, so every burn it
 * sees is one we earned a fee on. Until that contract is deployed the app burns straight
 * through Circle's contract, where nothing on chain marks a burn as ours — so the frontend
 * hands us the hash over `POST /burns` instead. Both paths converge on `upsertBySourceTx`,
 * whose unique index makes a burn arriving twice a no-op rather than a second paid mint.
 */

import { randomUUID } from "node:crypto";
import { rpc } from "@stellar/stellar-sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { createIrisClient } from "@xebra/cctp-client";
import { createDb } from "@xebra/db";
import { registerPolledGauge, startObservability } from "@xebra/observability";
import pino from "pino";
import { scanForBurns, submitBurn, type BurnWatcherDeps } from "./burn-watcher.js";
import { loadConfig } from "./config.js";
import { PostgresCursorStore } from "./cursor-store.js";
import { decodeRelayKeypair } from "./decode-keypair.js";
import { startRelayHttpServer } from "./http.js";
import { PostgresRelayJobStore } from "./postgres-job-store.js";
import { createRpcEventReader, createSorobanBurnSource } from "./soroban-burn-source.js";
import { createSolanaMintSubmitter } from "./solana-mint-submitter.js";
import { enqueueRelayJob, startWorker } from "./worker.js";

const logger = pino({ name: "cctp-relay" });

async function main() {
  const config = loadConfig();
  const obs = startObservability({ serviceName: "cctp-relay" });

  const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
  const payer = decodeRelayKeypair(config.RELAY_SOLANA_KEYPAIR);
  const iris = createIrisClient(config.IRIS_BASE_URL);
  const db = createDb(config.DATABASE_URL);
  const store = new PostgresRelayJobStore(db);
  const cursors = new PostgresCursorStore(db);

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

  const { queue, worker } = startWorker({
    connection: { url: config.REDIS_URL },
    deps: {
      iris,
      mint,
      store,
      pollIntervalMs: config.RELAY_POLL_INTERVAL_MS,
      maxAttempts: config.RELAY_MAX_ATTEMPTS,
    },
    logger,
    meter: obs.meter,
  });

  const readBurnEvents = config.STELLAR_CCTP_WRAPPER_CONTRACT_ID
    ? createSorobanBurnSource(
        createRpcEventReader(
          new rpc.Server(config.SOROBAN_RPC_URL),
          config.STELLAR_CCTP_WRAPPER_CONTRACT_ID,
          // Non-null: the config schema requires a start ledger whenever a contract id is set.
          config.SOROBAN_START_LEDGER as number,
        ),
      )
    : undefined;

  const watcher: BurnWatcherDeps = {
    readBurnEvents: readBurnEvents ?? (async () => ({ events: [], nextCursor: undefined })),
    upsertBySourceTx: (job) => store.upsertBySourceTx(job),
    enqueue: (job) => enqueueRelayJob(queue, job),
    loadCursor: () => cursors.load(),
    saveCursor: (cursor) => cursors.save(cursor),
    sourceDomainId: config.STELLAR_CCTP_DOMAIN_ID,
    newJobId: () => randomUUID(),
    now: () => Date.now(),
    log: (message, fields) => logger.info(fields ?? {}, `cctp-relay: ${message}`),
  };

  const http = startRelayHttpServer({
    port: config.RELAY_HTTP_PORT,
    submitToken: config.RELAY_SUBMIT_TOKEN,
    submit: async (txHash) => {
      const { job, created } = await submitBurn(watcher, txHash);
      return { jobId: job.id, created };
    },
    health: async () => {
      try {
        // A relay that cannot reach Postgres cannot record a job, so it must not take traffic:
        // accepting a burn it then forgets is worse than refusing it, because the caller
        // believes the transfer is being handled.
        await cursors.load();
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: { database: err instanceof Error ? err.message : "down" } };
      }
    },
    log: (message, fields) => logger.info(fields ?? {}, `cctp-relay: ${message}`),
  });

  let running = true;

  async function watchLoop() {
    while (running) {
      if (readBurnEvents) {
        try {
          const result = await scanForBurns(watcher);
          if (result.queued > 0 || result.duplicates > 0) {
            logger.info(result, "cctp-relay: burn scan");
          }
        } catch (err) {
          // Never fatal. A failed scan re-runs from the same cursor next tick; the cursor is
          // only advanced after a batch is durable, so nothing is skipped by an error here.
          logger.error({ err }, "cctp-relay: burn scan failed");
        }
      }
      await new Promise((resolve) => setTimeout(resolve, config.BURN_SCAN_INTERVAL_MS));
    }
  }

  void watchLoop();

  logger.info(
    {
      solanaRpc: config.SOLANA_RPC_URL,
      relayWallet: payer.publicKey.toBase58(),
      httpPort: config.RELAY_HTTP_PORT,
      wrapperContract: config.STELLAR_CCTP_WRAPPER_CONTRACT_ID || "(not deployed — direct mode)",
    },
    "cctp-relay: started",
  );

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      logger.info({ signal }, "cctp-relay: shutting down");
      running = false;
      http.close();
      await worker.close();
      await queue.close();
      await obs.shutdown();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.error({ err }, "cctp-relay: fatal startup error");
  process.exit(1);
});
