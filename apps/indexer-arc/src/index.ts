/**
 * @xebra/indexer-arc — Arc (EVM) chain watcher. Normalizes IntentOpened/Claimed/Challenged/
 * Resolved/Finalized/Refunded events from XebraEscrow and publishes them to the Redpanda event
 * backbone. See docs/architecture.md §8. Decode logic lives in @xebra/chain-adapters (proven
 * against a real anvil-deployed contract); this file is just live wiring.
 */

import { createEventProducer, createKafkaClient } from "@xebra/event-bus";
import { startObservability } from "@xebra/observability";
import pino from "pino";
import { loadConfig } from "./config.js";
import { startWatching } from "./watch.js";

const logger = pino({ name: "indexer-arc" });

async function main() {
  const config = loadConfig();
  const obs = startObservability({ serviceName: "indexer-arc" });

  const kafka = createKafkaClient({
    clientId: "indexer-arc",
    brokers: config.KAFKA_BROKERS.split(","),
  });
  const producer = createEventProducer(kafka.producer());

  const { stop } = startWatching(
    config.ARC_RPC_URL,
    config.ARC_ESCROW_ADDRESS as `0x${string}`,
    producer,
    logger,
  );

  logger.info({ escrow: config.ARC_ESCROW_ADDRESS }, "indexer-arc: watching");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      logger.info({ signal }, "indexer-arc: shutting down");
      stop();
      await producer.disconnect();
      await obs.shutdown();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.error({ err }, "indexer-arc: fatal startup error");
  process.exit(1);
});
