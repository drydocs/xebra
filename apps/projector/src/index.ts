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
import { registerPolledGauge, startObservability } from "@xebra/observability";
import pino from "pino";
import { z } from "zod";
import { countNearingClose, fetchUnchallengedClaimedRows } from "./near-window-close.js";
import { projectEvent } from "./projector.js";

const logger = pino({ name: "projector" });

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1),
  KAFKA_BROKERS: z.string().min(1),
  // docs/architecture.md §11's alert fires once a claim is within this many ms of its challenge
  // window closing with nobody having disputed it — default 10 minutes.
  NEAR_WINDOW_CLOSE_THRESHOLD_MS: z.coerce.number().int().positive().default(600_000),
});

async function main() {
  const config = ConfigSchema.parse(process.env);
  const db = createDb(config.DATABASE_URL);
  const obs = startObservability({ serviceName: "projector" });

  registerPolledGauge(
    obs.meter,
    "unclaimed_intents_nearing_window_close",
    {
      description:
        "Claimed-but-unchallenged intents within NEAR_WINDOW_CLOSE_THRESHOLD_MS of their challenge window closing.",
    },
    async () =>
      countNearingClose(
        await fetchUnchallengedClaimedRows(db),
        config.NEAR_WINDOW_CLOSE_THRESHOLD_MS,
        Date.now(),
      ),
  );

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
      await obs.shutdown();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.error({ err }, "projector: fatal startup error");
  process.exit(1);
});
