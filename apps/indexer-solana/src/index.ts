/**
 * @xebra/indexer-solana — watches known solver wallets for delivery transactions and publishes
 * normalized "Delivery" ChainEvents to the event backbone. See docs/architecture.md §4, §8, and
 * watch.ts's module doc comment for why this watches addresses rather than a contract.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { createEventProducer, createKafkaClient } from "@xebra/event-bus";
import pino from "pino";
import { loadConfig } from "./config.js";
import { type SolanaTxSource, pollOnce } from "./watch.js";

const logger = pino({ name: "indexer-solana" });

function createTxSource(connection: Connection): SolanaTxSource {
  return {
    async getSignaturesForAddress(address, opts) {
      return connection.getSignaturesForAddress(new PublicKey(address), opts);
    },
    async getParsedTransaction(signature) {
      return connection.getParsedTransaction(signature, { maxSupportedTransactionVersion: 0 });
    },
  };
}

async function main() {
  const config = loadConfig();
  const connection = new Connection(config.SOLANA_RPC_URL, "confirmed");
  const source = createTxSource(connection);

  const kafka = createKafkaClient({
    clientId: "indexer-solana",
    brokers: config.KAFKA_BROKERS.split(","),
  });
  const producer = createEventProducer(kafka.producer());

  const solverAddresses = config.SOLVER_ADDRESSES.split(",");
  const lastSeen = new Map<string, string | undefined>();

  logger.info({ solverAddresses }, "indexer-solana: polling");

  let running = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      logger.info({ signal }, "indexer-solana: shutting down");
      running = false;
      await producer.disconnect();
      process.exit(0);
    });
  }

  while (running) {
    for (const address of solverAddresses) {
      try {
        const newest = await pollOnce(source, address, lastSeen.get(address), producer, logger);
        lastSeen.set(address, newest);
      } catch (err) {
        logger.error({ err, address }, "indexer-solana: poll failed");
      }
    }
    await new Promise((resolve) => setTimeout(resolve, config.POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  logger.error({ err }, "indexer-solana: fatal startup error");
  process.exit(1);
});
