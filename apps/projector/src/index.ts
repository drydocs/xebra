/**
 * @xebra/projector — the "Kafka->DB projector" flagged throughout this codebase as a known gap
 * (docs/architecture.md §8's service table). Consumes the event backbone and populates
 * packages/db's tables so apps/api serves real live state instead of only whatever a manual
 * seed put in Postgres, apps/solver can read intents from the DB instead of raw events, and
 * apps/arbiter-service can look up a challenged claim's details. See projector.ts for exactly
 * what is and isn't projected yet.
 */

import { createDb } from "@xebra/db";
import { createEventConsumer, createKafkaClient } from "@xebra/event-bus";
import pino from "pino";
import { z } from "zod";
import { projectEvent } from "./projector.js";

const logger = pino({ name: "projector" });

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  KAFKA_BROKERS: z.string().min(1),
});

async function main() {
  const config = ConfigSchema.parse(process.env);
  const db = createDb(config.DATABASE_URL);

  const kafka = createKafkaClient({
    clientId: "projector",
    brokers: config.KAFKA_BROKERS.split(","),
  });
  const consumer = createEventConsumer(kafka.consumer({ groupId: "projector" }), (event) =>
    projectEvent(db, event, logger),
  );

  await consumer.start();
  logger.info("projector: consuming chain events");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      logger.info({ signal }, "projector: shutting down");
      await consumer.stop();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.error({ err }, "projector: fatal startup error");
  process.exit(1);
});
