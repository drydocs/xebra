/**
 * @xebra/indexer-stellar — watches both the new Stellar-source XebraEscrow contract (Soroban
 * RPC getEvents) and, for the existing Arc->Stellar corridor, fulfillment payments to known
 * destination addresses (Horizon). See watch.ts's module doc comment and docs/architecture.md
 * §8. Decode logic lives in @xebra/chain-adapters; this file is live wiring + the poll loop.
 */

import { Horizon, rpc } from "@stellar/stellar-sdk";
import { createEventProducer, createKafkaClient } from "@xebra/event-bus";
import { startObservability } from "@xebra/observability";
import pino from "pino";
import { loadConfig } from "./config.js";
import {
  type HorizonPaymentSource,
  type SorobanEventSource,
  pollFulfillmentPaymentsOnce,
  pollSorobanEventsOnce,
} from "./watch.js";

const logger = pino({ name: "indexer-stellar" });

function createSorobanSource(server: rpc.Server, startLedger: number): SorobanEventSource {
  return {
    async getEvents(cursor, contractId) {
      return server.getEvents({
        filters: [{ type: "contract", contractIds: [contractId] }],
        ...(cursor ? { cursor } : { startLedger }),
        limit: 100,
      });
    },
  };
}

function createHorizonSource(server: Horizon.Server): HorizonPaymentSource {
  return {
    async getPayments(address, cursor) {
      let builder = server.payments().forAccount(address).order("asc").limit(100);
      if (cursor) builder = builder.cursor(cursor);
      const page = await builder.call();
      const records = page.records.filter(
        (r): r is Horizon.ServerApi.PaymentOperationRecord => r.type === "payment",
      );
      const nextCursor = records.at(-1)?.paging_token ?? cursor;
      return { records, nextCursor };
    },
    async getTransaction(hash) {
      return server.transactions().transaction(hash).call();
    },
  };
}

async function main() {
  const config = loadConfig();
  const obs = startObservability({ serviceName: "indexer-stellar" });

  const sorobanServer = new rpc.Server(config.SOROBAN_RPC_URL);
  const horizonServer = new Horizon.Server(config.HORIZON_URL);
  const sorobanSource = createSorobanSource(sorobanServer, config.SOROBAN_START_LEDGER);
  const horizonSource = createHorizonSource(horizonServer);

  const kafka = createKafkaClient({
    clientId: "indexer-stellar",
    brokers: config.KAFKA_BROKERS.split(","),
  });
  const producer = createEventProducer(kafka.producer());

  const fulfillmentAddresses = config.FULFILLMENT_WATCH_ADDRESSES.split(",");
  let sorobanCursor: string | undefined;
  const horizonCursors = new Map<string, string | undefined>();

  logger.info(
    { contract: config.SOROBAN_ESCROW_CONTRACT_ID, fulfillmentAddresses },
    "indexer-stellar: polling",
  );

  let running = true;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      logger.info({ signal }, "indexer-stellar: shutting down");
      running = false;
      await producer.disconnect();
      await obs.shutdown();
      process.exit(0);
    });
  }

  while (running) {
    try {
      sorobanCursor = await pollSorobanEventsOnce(
        sorobanSource,
        config.SOROBAN_ESCROW_CONTRACT_ID,
        sorobanCursor,
        producer,
        logger,
      );
    } catch (err) {
      logger.error({ err }, "indexer-stellar: soroban poll failed");
    }

    for (const address of fulfillmentAddresses) {
      try {
        const cursor = await pollFulfillmentPaymentsOnce(
          horizonSource,
          address,
          horizonCursors.get(address),
          producer,
          logger,
        );
        horizonCursors.set(address, cursor);
      } catch (err) {
        logger.error({ err, address }, "indexer-stellar: horizon poll failed");
      }
    }

    await new Promise((resolve) => setTimeout(resolve, config.POLL_INTERVAL_MS));
  }
}

main().catch((err) => {
  logger.error({ err }, "indexer-stellar: fatal startup error");
  process.exit(1);
});
