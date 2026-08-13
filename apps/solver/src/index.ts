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

import { Connection as SolanaConnection, Keypair as SolanaKeypair } from "@solana/web3.js";
import { Keypair as StellarKeypair, rpc } from "@stellar/stellar-sdk";
import { createEventConsumer, createKafkaClient } from "@xebra/event-bus";
import pino from "pino";
import { createSolanaFillAdapter } from "./adapters/solana-fill.js";
import { createStellarClaimAdapter } from "./adapters/stellar-claim.js";
import { loadConfig } from "./config.js";
import { intentFromChainEvent } from "./decode-intent-event.js";
import { processOpenedIntent } from "./fill-loop.js";

const logger = pino({ name: "solver" });

async function main() {
  const config = loadConfig();

  const solanaConnection = new SolanaConnection(config.SOLANA_RPC_URL, "confirmed");
  const solanaKeypair = SolanaKeypair.fromSecretKey(
    Buffer.from(config.SOLVER_SOLANA_KEYPAIR, "base64"),
  );
  const sorobanServer = new rpc.Server(config.SOROBAN_RPC_URL);
  const stellarKeypair = StellarKeypair.fromSecret(config.SOLVER_STELLAR_SECRET);

  const fill = createSolanaFillAdapter(solanaConnection, solanaKeypair, {
    // TODO: wire to real SPL balance checks (getAccount/getTokenAccountBalance) — placeholder
    // "always sufficient" until inventory tracking (docs/architecture.md §11's
    // solver_inventory_snapshots) is wired up.
    getBalance: async () => 2n ** 64n,
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
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.error({ err }, "solver: fatal startup error");
  process.exit(1);
});
