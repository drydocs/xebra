"use node";

import { type RelayJobState, createIrisClient } from "@xebra/cctp-client";
import { createSolanaMintSubmitterFromConfig, getRelayBalanceLamports } from "@xebra/cctp-solana";
import {
  type BurnWatcherDeps,
  type DrainDeps,
  assessRelayBalance,
  checkBurnAdmission,
  createBurnReaderFromUrl,
  createHorizonBurnClock,
  drainDueJobs,
  isStellarTxHash,
  scanForBurns,
  submitBurn as submitBurnToStore,
} from "@xebra/relay-core";
import { v } from "convex/values";
import { api, internal } from "./_generated/api";
import { type ActionCtx, action, internalAction } from "./_generated/server";

/**
 * The relay, as Convex actions.
 *
 * `"use node"`: this file signs Solana transactions and reads Soroban events, which needs the
 * Node runtime and real npm packages rather than Convex's default isolate.
 *
 * # Why actions and not mutations
 *
 * Everything here talks to something outside the database — Circle's Iris API, Solana RPC,
 * Horizon. Convex mutations are transactional and may be retried, which is exactly wrong for a
 * function that submits a transaction: a retry would submit it twice. Actions are the escape
 * hatch, and the cost of that escape hatch is that they are *not* transactional, which is why
 * `jobs.claimDue` hands out a lease before any of this runs.
 *
 * # What is shared with the container relay
 *
 * All of it. `drainDueJobs`, `processJob`, `advanceRelayJob`, `scanForBurns`,
 * `checkBurnAdmission` and the `receiveMessage` instruction come from `@xebra/relay-core` and
 * `@xebra/cctp-solana` unmodified; this file supplies the storage adapters and the config. There
 * is one implementation of the part that moves money, and `apps/cctp-relay` runs the same one.
 */

const CURSOR_NAME = "stellar-burns";

class MissingConfig extends Error {
  constructor(names: string[]) {
    super(`relay is not configured: ${names.join(", ")} not set`);
    this.name = "MissingConfig";
  }
}

function config() {
  const read = (name: string) => process.env[name];
  const missing = ["RELAY_SOLANA_KEYPAIR", "SOLANA_RPC_URL", "SOLANA_USDC_MINT"].filter(
    (name) => !read(name),
  );
  if (missing.length > 0) throw new MissingConfig(missing);

  return {
    relayKeypair: read("RELAY_SOLANA_KEYPAIR") as string,
    solanaRpcUrl: read("SOLANA_RPC_URL") as string,
    usdcMint: read("SOLANA_USDC_MINT") as string,
    // Defaults are the pinned mainnet constants. A wrong Iris endpoint is worth stating rather
    // than leaving to configuration: attesting against the sandbox leaves every burn "pending"
    // forever instead of failing loudly.
    irisBaseUrl: read("IRIS_BASE_URL") ?? "https://iris-api.circle.com",
    horizonUrl: read("HORIZON_URL") ?? "https://horizon.stellar.org",
    sorobanRpcUrl: read("SOROBAN_RPC_URL") ?? "https://mainnet.sorobanrpc.com",
    sourceDomainId: Number(read("STELLAR_CCTP_DOMAIN_ID") ?? "27"),
    wrapperContractId: read("STELLAR_CCTP_WRAPPER_CONTRACT_ID") ?? "",
    startLedger: Number(read("SOROBAN_START_LEDGER") ?? "0"),
    opsToken: read("RELAY_SUBMIT_TOKEN") ?? "",
  };
}

/** Splits a `RelayJobState` into the argument shape the mutations take. */
function toArgs(job: RelayJobState) {
  return {
    jobId: job.id,
    sourceDomainId: job.sourceDomainId,
    sourceTxHash: job.sourceTxHash,
    status: job.status,
    message: job.message,
    attestation: job.attestation,
    destTxSignature: job.destTxSignature,
    attempts: job.attempts,
    lastError: job.lastError,
    createdAt: job.createdAt,
  };
}

function deps(ctx: ActionCtx) {
  const cfg = config();
  const log = (message: string, fields?: Record<string, unknown>) =>
    console.log(`[relay] ${message}`, fields ?? {});

  const store = {
    save: async (job: RelayJobState) => {
      await ctx.runMutation(internal.jobs.save, toArgs(job));
    },
    get: async (id: string) => (await ctx.runQuery(internal.jobs.get, { jobId: id })) ?? undefined,
  };

  const readBurnEvents =
    cfg.wrapperContractId && cfg.startLedger > 0
      ? createBurnReaderFromUrl(cfg.sorobanRpcUrl, cfg.wrapperContractId, cfg.startLedger)
      : undefined;

  const watcher: BurnWatcherDeps = {
    readBurnEvents: readBurnEvents ?? (async () => ({ events: [], nextCursor: undefined })),
    upsertBySourceTx: (job) => ctx.runMutation(internal.jobs.upsertBySourceTx, toArgs(job)),
    // The row is the queue — a freshly inserted job is already due — so there is nothing to
    // enqueue beyond the insert that just happened. Which is also why the insert must come first.
    enqueue: async () => undefined,
    loadCursor: async () =>
      (await ctx.runQuery(internal.cursors.load, { name: CURSOR_NAME })) ?? undefined,
    saveCursor: async (cursor) => {
      await ctx.runMutation(internal.cursors.save, { name: CURSOR_NAME, cursor });
    },
    sourceDomainId: cfg.sourceDomainId,
    newJobId: () => crypto.randomUUID(),
    now: () => Date.now(),
    log,
  };

  const drain: DrainDeps = {
    iris: createIrisClient(cfg.irisBaseUrl),
    mint: createSolanaMintSubmitterFromConfig({
      rpcUrl: cfg.solanaRpcUrl,
      secretKey: cfg.relayKeypair,
      usdcMint: cfg.usdcMint,
      sourceDomainId: cfg.sourceDomainId,
    }),
    store,
    pollIntervalMs: 5_000,
    maxAttempts: 10,
    claimDueJobs: (limit, leaseMs) => ctx.runMutation(internal.jobs.claimDue, { limit, leaseMs }),
    reschedule: async (job, decision) => {
      await ctx.runMutation(internal.jobs.reschedule, {
        jobId: job.id,
        ...(decision.type === "requeue" ? { delayMs: decision.delayMs } : {}),
        ...(decision.type === "dead-letter" ? { deadLetterReason: decision.reason } : {}),
      });
    },
    log,
  };

  return { cfg, watcher, drain, hasWatcher: Boolean(readBurnEvents) };
}

/**
 * Records a burn and mints it, in one call.
 *
 * Public — the browser reaches this after signing a burn. That is why the admission checks are
 * here and not in the internal functions: every mint costs the relay 867,621 lamports of
 * permanent rent, and until the wrapper contract is deployed there is nothing on chain that
 * distinguishes a burn made through this app from any other CCTP user's burn on Stellar. See
 * `admission.ts` for what the bounds do and do not achieve.
 *
 * `opsToken` bypasses them, for re-driving an old burn by hand — which the recency check would
 * otherwise refuse.
 *
 * A refusal is never a lost transfer. The burn is already on chain, Circle's attestation is
 * public and never expires, and anyone holding it can complete the mint.
 */
export const submitBurn = action({
  args: { txHash: v.string(), opsToken: v.optional(v.string()) },
  handler: async (ctx, { txHash, opsToken }) => {
    if (!isStellarTxHash(txHash)) {
      return { status: "rejected" as const, reason: "txHash must be 64 lower-case hex characters" };
    }

    let d: ReturnType<typeof deps>;
    try {
      d = deps(ctx);
    } catch (err) {
      if (err instanceof MissingConfig) {
        return { status: "unavailable" as const, reason: err.message };
      }
      throw err;
    }

    // Compared by value rather than constant-time: an attacker who can guess this token has no
    // more power than an ordinary caller inside the admission bounds, and the token is not
    // reachable from the browser at all — the web route supplies it, if it supplies it.
    const privileged = Boolean(d.cfg.opsToken && opsToken === d.cfg.opsToken);

    if (!privileged) {
      const verdict = await checkBurnAdmission(
        {
          burnClosedAt: createHorizonBurnClock(d.cfg.horizonUrl),
          countSponsoredSince: (since) =>
            ctx.runQuery(internal.jobs.countSponsoredSince, { since }),
        },
        txHash,
      );
      if (!verdict.admit) return { status: "unavailable" as const, reason: verdict.reason };
    }

    const { job, created } = await submitBurnToStore(d.watcher, txHash);

    // Drive it as far as it goes now, on a shorter budget than the cron sweep's: someone is
    // waiting on this response, so an attestation that is not ready yet is left to the sweep
    // rather than held open.
    const drained = await drainDueJobs(d.drain, { maxJobs: 3, budgetMs: 25_000 });

    return { status: "queued" as const, jobId: job.id, created, drained };
  },
});

/**
 * The heartbeat, on a schedule (see `crons.ts`).
 *
 * Internal, so only the cron and an operator can invoke it: scan for burns the watcher can see, then drain everything due. This catches
 * what `submitBurn` could not finish — an attestation that was not ready, a Solana submission
 * backing off, a burn nobody told us about.
 *
 * A failed scan does not stop the drain. The cursor only advances after a batch is durable, so
 * nothing is skipped by retrying on the next tick, and jobs already recorded have nothing to do
 * with whether the scan succeeded.
 */
export const tick = internalAction({
  args: {},
  handler: async (ctx) => {
    let d: ReturnType<typeof deps>;
    try {
      d = deps(ctx);
    } catch (err) {
      if (err instanceof MissingConfig) {
        console.warn(`[relay] ${err.message}`);
        return { status: "unconfigured" as const, reason: err.message };
      }
      throw err;
    }

    let scan: Awaited<ReturnType<typeof scanForBurns>> | null = null;
    if (d.hasWatcher) {
      try {
        scan = await scanForBurns(d.watcher);
      } catch (err) {
        console.error("[relay] burn scan failed", err);
      }
    }

    const drained = await drainDueJobs(d.drain, { budgetMs: 120_000 });
    return { status: "ok" as const, scan, drained };
  },
});

/**
 * The relay's own health, for a monitor to watch.
 *
 * Public, and deliberately so: it reports a balance and a threshold, both of which are already
 * visible on chain to anyone who looks up the hot wallet. Making it authenticated would mean the
 * only things that could check it are things that hold a secret, which rules out every free uptime
 * monitor — and an alert nobody receives is not an alert.
 */
export const health = action({
  args: {},
  handler: async () => {
    let cfg: ReturnType<typeof config>;
    try {
      cfg = config();
    } catch (err) {
      if (err instanceof MissingConfig) {
        return { ok: false, level: "critical" as const, message: err.message };
      }
      throw err;
    }

    try {
      const balance = await getRelayBalanceLamports({
        rpcUrl: cfg.solanaRpcUrl,
        secretKey: cfg.relayKeypair,
      });
      return assessRelayBalance(balance);
    } catch (err) {
      // Not reaching Solana is itself worth paging about: the relay cannot mint either.
      return {
        ok: false,
        level: "critical" as const,
        message: `could not read the relay balance: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});

/**
 * Scheduled balance check.
 *
 * Throws when the balance is critical, rather than logging. A thrown error shows as a failed
 * function in the Convex dashboard and in whatever exception reporting is configured, where a
 * `console.error` is one line in a log nobody reads. The whole point is that this failure is
 * otherwise invisible — a transfer that cannot be paid for looks exactly like one waiting on
 * attestation.
 */
export const checkBalance = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const result = (await ctx.runAction(api.relay.health, {})) as {
      ok: boolean;
      level: string;
      message: string;
    };

    if (!result.ok)
      throw new Error(`RELAY BALANCE ${result.level.toUpperCase()}: ${result.message}`);
    if (result.level === "warning") console.warn(`[relay] ${result.message}`);
  },
});
