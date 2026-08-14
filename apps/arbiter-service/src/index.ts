/**
 * @xebra/arbiter-service — KMS-backed resolve() submitter for the v1 admin-arbiter role
 * (docs/architecture.md §8). Watches for "IntentChallenged" events and, once a challenge lands,
 * verifies the solver's claim against the actual destination-chain delivery (via
 * @xebra/chain-adapters — the same falsifiable check anyone else could run) and submits
 * resolve() on whichever escrow raised the challenge.
 *
 * NOT FULLY WIRED: resolving a challenge needs the claim's asserted destination tx reference,
 * minDestAmount, destAsset, and destAddress — fields carried on the earlier IntentClaimed
 * event, not IntentChallenged itself. Correlating the two currently requires the "Kafka->DB
 * projector" gap noted in the repo README (nothing yet persists events to Postgres for lookup).
 * The pieces that ARE real and independently verified: decide.ts (the validity decision, a
 * one-line wrapper around chain-adapters' own verification — no separate arbiter policy),
 * evm-account.ts + resolve-arc.ts (KMS-signed Arc resolve() calls, tested against real
 * secp256k1 signing/recovery), and resolve-soroban.ts (KMS-signed Soroban resolve() calls).
 * This file wires the KMS signers to live events but cannot yet fetch the claim data resolve()
 * needs — once the projector exists, the handler below becomes:
 *
 *   const claim = await lookupClaim(db, event.intentHash);
 *   const verified = await verifyClaimAgainstDestinationChain(claim);
 *   const claimValid = decideClaimValidity(verified);
 *   const result = event.chainId === ChainId.ArcEvm
 *     ? await resolveOnArc(config.ARC_RPC_URL, config.ARC_ESCROW_ADDRESS, evmSigner, event.intentHash, claimValid)
 *     : await resolveOnSoroban(sorobanServer, config.STELLAR_ESCROW_CONTRACT_ID, stellarSigner, config.STELLAR_NETWORK_PASSPHRASE, event.intentHash, claimValid);
 */

import { KMSClient } from "@aws-sdk/client-kms";
import { createKmsEvmSigner, createKmsStellarSigner } from "@xebra/arbiter-signer";
import { createEventConsumer, createKafkaClient } from "@xebra/event-bus";
import pino from "pino";
import { loadConfig } from "./config.js";

const logger = pino({ name: "arbiter-service" });

async function main() {
  const config = loadConfig();
  const kms = new KMSClient({ region: config.KMS_REGION });

  const [evmSigner, stellarSigner] = await Promise.all([
    createKmsEvmSigner(kms, config.ARBITER_EVM_KMS_KEY_ID),
    createKmsStellarSigner(kms, config.ARBITER_STELLAR_KMS_KEY_ID),
  ]);
  logger.info(
    { evmAddress: evmSigner.address, stellarAddress: stellarSigner.publicKey },
    "arbiter-service: KMS signers ready",
  );

  const kafka = createKafkaClient({
    clientId: "arbiter-service",
    brokers: config.KAFKA_BROKERS.split(","),
  });
  const consumer = createEventConsumer(
    kafka.consumer({ groupId: "arbiter-service" }),
    async (event) => {
      if (event.eventType !== "IntentChallenged" || !event.intentHash) return;

      logger.warn(
        { intentHash: event.intentHash, chainId: event.chainId },
        "arbiter-service: challenge observed, but claim verification is not wired yet (needs the " +
          "Kafka->DB projector — see this file's module doc comment); resolve() not submitted",
      );
    },
  );

  await consumer.start();
  logger.info("arbiter-service: watching for IntentChallenged events");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      logger.info({ signal }, "arbiter-service: shutting down");
      await consumer.stop();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.error({ err }, "arbiter-service: fatal startup error");
  process.exit(1);
});
