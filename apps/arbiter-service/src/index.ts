/**
 * @xebra/arbiter-service — KMS-backed resolve() submitter for the v1 admin-arbiter role
 * (docs/architecture.md §8). Watches for "IntentChallenged" events and, once a challenge lands,
 * verifies the solver's claim against the actual destination-chain delivery (via
 * @xebra/chain-adapters — the same falsifiable check anyone else could run) and submits
 * resolve() on whichever escrow raised the challenge.
 *
 * Both corridors' verification paths are wired: the new Stellar->Solana corridor
 * (verify-claim.ts's Solana branch, against a real fetched+parsed Solana tx) and the existing
 * Arc->Stellar corridor (verify-stellar-fulfillment.ts, against a real fetched Horizon payment).
 * decide.ts is the one-line wrapper turning either verification into the `claimValid` bool
 * `resolve()` needs — no separate arbiter policy layer. lookup-claim.ts is the join against
 * apps/projector/src/project-claim.ts's now-populated `claims` table that makes any of this
 * possible. evm-account.ts + resolve-arc.ts / resolve-soroban.ts submit the actual KMS-signed
 * resolve() call on whichever escrow raised the challenge.
 */

import { KMSClient } from "@aws-sdk/client-kms";
import { Connection as SolanaConnection } from "@solana/web3.js";
import { Horizon, rpc } from "@stellar/stellar-sdk";
import { createKmsEvmSigner, createKmsStellarSigner } from "@xebra/arbiter-signer";
import { createDb } from "@xebra/db";
import { createEventConsumer, createKafkaClient } from "@xebra/event-bus";
import { ChainId } from "@xebra/intent-schema";
import { registerPolledGauge, startObservability } from "@xebra/observability";
import pino from "pino";
import { loadConfig } from "./config.js";
import { decideClaimValidity } from "./decide.js";
import { lookupClaim } from "./lookup-claim.js";
import { resolveOnArc } from "./resolve-arc.js";
import { resolveOnSoroban } from "./resolve-soroban.js";
import { verifyClaimAgainstDestinationChain } from "./verify-claim.js";
import type { StellarFulfillmentSource } from "./verify-stellar-fulfillment.js";

const logger = pino({ name: "arbiter-service" });

async function main() {
  const config = loadConfig();
  const obs = startObservability({ serviceName: "arbiter-service" });
  const kms = new KMSClient({ region: config.KMS_REGION });
  const db = createDb(config.DATABASE_URL);
  const solanaConnection = new SolanaConnection(config.SOLANA_RPC_URL, "confirmed");
  const sorobanServer = new rpc.Server(config.SOROBAN_RPC_URL);
  const horizonServer = new Horizon.Server(config.HORIZON_URL);
  const stellarSource: StellarFulfillmentSource = {
    getTransaction: (hash) => horizonServer.transactions().transaction(hash).call(),
    getPaymentsForTransaction: async (hash) => {
      const page = await horizonServer.payments().forTransaction(hash).call();
      return page.records.filter(
        (
          r,
        ): r is
          | Horizon.ServerApi.PaymentOperationRecord
          | Horizon.ServerApi.PathPaymentOperationRecord =>
          r.type === "payment" ||
          r.type === "path_payment_strict_receive" ||
          r.type === "path_payment_strict_send",
      );
    },
  };

  // docs/architecture.md §11's "arbiter KMS failures" alert — covers both the startup
  // GetPublicKey calls below and, now that the resolve path is wired, the Sign calls inside
  // resolveOnArc/resolveOnSoroban.
  const kmsFailures = obs.meter.createCounter("arbiter_kms_failures_total", {
    description: "KMS calls made by the arbiter service that threw.",
  });
  let pendingChallenges = 0;
  registerPolledGauge(
    obs.meter,
    "arbiter_pending_challenges",
    {
      description:
        "IntentChallenged events observed but not yet resolved (claim missing or destination unverifiable).",
    },
    () => pendingChallenges,
  );

  const [evmSigner, stellarSigner] = await Promise.all([
    createKmsEvmSigner(kms, config.ARBITER_EVM_KMS_KEY_ID).catch((err) => {
      kmsFailures.add(1, { operation: "createKmsEvmSigner" });
      throw err;
    }),
    createKmsStellarSigner(kms, config.ARBITER_STELLAR_KMS_KEY_ID).catch((err) => {
      kmsFailures.add(1, { operation: "createKmsStellarSigner" });
      throw err;
    }),
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

      const claim = await lookupClaim(db, event.intentHash);
      if (!claim) {
        pendingChallenges++;
        logger.warn(
          { intentHash: event.intentHash, chainId: event.chainId },
          "arbiter-service: challenge observed but no claim row found yet (possibly out-of-order " +
            "delivery relative to IntentClaimed) — not resolving",
        );
        return;
      }

      const verification = await verifyClaimAgainstDestinationChain(
        solanaConnection,
        stellarSource,
        claim,
      );
      if (!verification.ok) {
        pendingChallenges++;
        logger.warn(
          { intentHash: event.intentHash, reason: verification.reason },
          "arbiter-service: can't verify this claim's destination chain yet — not resolving",
        );
        return;
      }

      const claimValid = decideClaimValidity(verification.verified);
      logger.info(
        {
          intentHash: event.intentHash,
          chainId: event.chainId,
          claimValid,
          reason: verification.reason,
        },
        "arbiter-service: resolving challenge",
      );

      try {
        const result =
          event.chainId === ChainId.ArcEvm
            ? await resolveOnArc(
                config.ARC_RPC_URL,
                config.ARC_ESCROW_ADDRESS as `0x${string}`,
                evmSigner,
                event.intentHash as `0x${string}`,
                claimValid,
              )
            : await resolveOnSoroban(
                sorobanServer,
                config.STELLAR_ESCROW_CONTRACT_ID,
                stellarSigner,
                config.STELLAR_NETWORK_PASSPHRASE,
                event.intentHash,
                claimValid,
              );
        logger.info(
          { intentHash: event.intentHash, ...result },
          "arbiter-service: resolve() submitted",
        );
      } catch (err) {
        kmsFailures.add(1, { operation: "resolve" });
        logger.error(
          { intentHash: event.intentHash, err },
          "arbiter-service: resolve() submission failed",
        );
      }
    },
  );

  await consumer.start();
  logger.info("arbiter-service: watching for IntentChallenged events");

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, async () => {
      logger.info({ signal }, "arbiter-service: shutting down");
      await consumer.stop();
      await obs.shutdown();
      process.exit(0);
    });
  }
}

main().catch((err) => {
  logger.error({ err }, "arbiter-service: fatal startup error");
  process.exit(1);
});
