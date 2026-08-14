/**
 * @xebra/solver — multi-chain fill bot. Consumes `IntentOpened` events from the event backbone
 * for the Stellar->Solana corridor, quotes/fills via the Solana adapter, then claims back on
 * the Stellar-source XebraEscrow contract. See docs/architecture.md §7 and fill-loop.ts's
 * module doc comment for the chain-adapter separation this composes.
 *
 * v1 scope: Stellar->Solana only (this build's new corridor). The Arc->Stellar corridor's
 * solver loop (Stellar DEX path-payment fills) is unchanged from the base spec and not
 * re-implemented here — see the frozen v1 spec for that corridor's solver behavior.
 */

import {
  TokenAccountNotFoundError,
  getAccount,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection as SolanaConnection, Keypair as SolanaKeypair } from "@solana/web3.js";
import { Keypair as StellarKeypair, rpc } from "@stellar/stellar-sdk";
import { createEventConsumer, createKafkaClient } from "@xebra/event-bus";
import { startObservability } from "@xebra/observability";
import pino from "pino";
import { createSolanaFillAdapter } from "./adapters/solana-fill.js";
import { createStellarClaimAdapter } from "./adapters/stellar-claim.js";
import { loadConfig } from "./config.js";
import { intentFromChainEvent } from "./decode-intent-event.js";
import { processOpenedIntent } from "./fill-loop.js";

const logger = pino({ name: "solver" });

async function main() {
  const config = loadConfig();
  const obs = startObservability({ serviceName: "solver" });

  const solanaConnection = new SolanaConnection(config.SOLANA_RPC_URL, "confirmed");
  const solanaKeypair = SolanaKeypair.fromSecretKey(
    Buffer.from(config.SOLVER_SOLANA_KEYPAIR, "base64"),
  );
  const sorobanServer = new rpc.Server(config.SOROBAN_RPC_URL);
  const stellarKeypair = StellarKeypair.fromSecret(config.SOLVER_STELLAR_SECRET);

  // Backs docs/architecture.md §11's "per-chain solver inventory low" alert: recorded on every
  // fill quote, so a Grafana panel/alert can watch this gauge directly rather than needing the
  // separate solver_inventory_snapshots table populated first.
  const inventoryGauge = obs.meter.createGauge("solver_inventory_amount", {
    description:
      "Solver's Solana token balance for a destination-asset mint, sampled on each fill quote.",
  });

  const fill = createSolanaFillAdapter(solanaConnection, solanaKeypair, {
    async getBalance(mint) {
      const ata = getAssociatedTokenAddressSync(mint, solanaKeypair.publicKey);
      let amount: bigint;
      try {
        amount = (await getAccount(solanaConnection, ata)).amount;
      } catch (err) {
        if (err instanceof TokenAccountNotFoundError) {
          amount = 0n;
        } else {
          throw err;
        }
      }
      inventoryGauge.record(Number(amount), { mint: mint.toBase58() });
      return amount;
    },
  });
  const claim = createStellarClaimAdapter(
    sorobanServer,
    config.STELLAR_ESCROW_CONTRACT_ID,
    stellarKeypair,
    config.STELLAR_NETWORK_PASSPHRASE,
  );

  const kafka = createKafkaClient({ clientId: "solver", brokers: config.KAFKA_BROKERS.split(",") });
  const consumer = createEventConsumer(kafka.consumer({ groupId: "solver" }), async (event) => {
    const intent = intentFromChainEvent(event);
    if (!intent || !event.intentHash) return;

    const outcome = await processOpenedIntent(event.intentHash, intent, { fill, claim, logger });
    logger.info({ intentHash: event.intentHash, outcome }, "solver: processed intent");
  });

  await consumer.start();
  logger.info("solver: watching for IntentOpened events");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      logger.info({ signal }, "solver: shutting down");
      await consumer.stop();
      await obs.shutdown();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.error({ err }, "solver: fatal startup error");
  process.exit(1);
});
