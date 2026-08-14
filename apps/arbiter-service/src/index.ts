/**
 * @xebra/arbiter-service — KMS-backed resolve() submitter for the v1 admin-arbiter role
 * (docs/architecture.md §8). Watches for "IntentChallenged" events and, once a challenge lands,
 * verifies the solver's claim against the actual destination-chain delivery (via
 * @xebra/chain-adapters — the same falsifiable check anyone else could run) and submits
 * resolve() on whichever escrow raised the challenge.
 *
 * v1 scope: only the Stellar->Solana corridor's verification path is wired (see
 * verify-claim.ts) — resolving a challenge on the existing Arc->Stellar corridor still logs and
 * skips, since that corridor's Horizon-based fulfillment match check isn't written yet. The
 * pieces that ARE real and independently verified: decide.ts (the validity decision, a one-line
 * wrapper around chain-adapters' own verification — no separate arbiter policy), evm-account.ts
 * + resolve-arc.ts (KMS-signed Arc resolve() calls, tested against real secp256k1
 * signing/recovery), resolve-soroban.ts (KMS-signed Soroban resolve() calls), and lookup-claim.ts
 * / verify-claim.ts (the claims-table lookup and Solana-delivery verification this file now
 * wires end to end — see apps/projector/src/project-claim.ts for what populates `claims`).
 */

import { KMSClient } from "@aws-sdk/client-kms";
import { Connection as SolanaConnection } from "@solana/web3.js";
import { rpc } from "@stellar/stellar-sdk";
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

const logger = pino({ name: "arbiter-service" });

async function main() {
  const config = loadConfig();
  const obs = startObservability({ serviceName: "arbiter-service" });
  const kms = new KMSClient({ region: config.KMS_REGION });
  const db = createDb(config.DATABASE_URL);
  const solanaConnection = new SolanaConnection(config.SOLANA_RPC_URL, "confirmed");
  const sorobanServer = new rpc.Server(config.SOROBAN_RPC_URL);

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

      const verification = await verifyClaimAgainstDestinationChain(solanaConnection, claim);
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
