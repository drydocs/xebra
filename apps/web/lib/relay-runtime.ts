import { createIrisClient } from "@xebra/cctp-client";
import { createSolanaMintSubmitterFromConfig } from "@xebra/cctp-solana";
import { createDb } from "@xebra/db";
import {
  type BurnWatcherDeps,
  PostgresCursorStore,
  PostgresRelayJobStore,
  createBurnReaderFromUrl,
} from "@xebra/relay-core";
import { env } from "./env";

/**
 * The relay, assembled for a serverless invocation.
 *
 * # Why the relay runs here at all
 *
 * `apps/cctp-relay` is a long-running process: a BullMQ worker on Redis, a watcher loop, a
 * container. That needs somewhere to run a container. This project deploys to Vercel, so the
 * same pipeline is driven by two route handlers instead — one invoked by cron, one invoked when
 * a burn is submitted. `@xebra/relay-core` holds the part that moves money, so both shells run
 * identical logic.
 *
 * # Server-only
 *
 * This module reads secrets — the relay's Solana key, the database URL — and must never be
 * imported from a client component. Next.js would happily bundle it if something did, so
 * everything here is reached only from route handlers, which are server-only by construction.
 *
 * Note the deliberate asymmetry with `lib/env.ts`: that file exists to feed `NEXT_PUBLIC_*`
 * into the browser and cannot index `process.env` dynamically. Here there is no bundler
 * substitution involved at all, because none of these values may reach the client.
 */

export class MissingRelayConfig extends Error {
  constructor(missing: string[]) {
    super(`relay is not configured: ${missing.join(", ")} not set`);
    this.name = "MissingRelayConfig";
  }
}

/** Reports every missing variable at once, rather than one per deploy attempt. */
function required<K extends string>(values: Record<K, string | undefined>): Record<K, string> {
  const missing = (Object.keys(values) as K[]).filter((name) => !values[name]);
  if (missing.length > 0) throw new MissingRelayConfig(missing);
  return values as Record<K, string>;
}

/** Whether this deployment can relay at all. An unconfigured deployment is a valid state — the
 *  bridge works without a relay, users just pay their own mint gas — so callers report it as
 *  "unavailable" rather than as a failure. */
export function isRelayConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL && process.env.RELAY_SOLANA_KEYPAIR);
}

export function relayDeps() {
  const config = required({
    DATABASE_URL: process.env.DATABASE_URL,
    RELAY_SOLANA_KEYPAIR: process.env.RELAY_SOLANA_KEYPAIR,
  });

  // Server-side only, so plain `process.env` member access is correct here — there is no
  // bundler substitution to satisfy and these must not reach the browser. Defaults are the
  // pinned mainnet constants, which `packages/network-config` validates elsewhere; a wrong
  // Iris endpoint leaves burns "pending" forever rather than failing loudly, which is why it
  // is worth stating rather than leaving to an env file.
  const irisBaseUrl = process.env.IRIS_BASE_URL ?? "https://iris-api.circle.com";
  const sourceDomainId = Number(process.env.STELLAR_CCTP_DOMAIN_ID ?? "27");

  const db = createDb(config.DATABASE_URL);
  const store = new PostgresRelayJobStore(db);
  const cursors = new PostgresCursorStore(db);

  const mint = createSolanaMintSubmitterFromConfig({
    rpcUrl: env.solanaRpcUrl,
    secretKey: config.RELAY_SOLANA_KEYPAIR,
    usdcMint: env.usdcSolanaMint,
    sourceDomainId,
  });

  const wrapper = env.cctpWrapperContractId;
  const startLedger = Number(process.env.SOROBAN_START_LEDGER ?? "0");
  // The watcher only exists once the wrapper is deployed. Until then burns come in by hash from
  // `/api/relay/burns`, because a direct burn through Circle's contract carries nothing on chain
  // that marks it as ours.
  const readBurnEvents =
    wrapper && startLedger > 0
      ? createBurnReaderFromUrl(env.sorobanRpcUrl, wrapper, startLedger)
      : undefined;

  const watcher: BurnWatcherDeps = {
    readBurnEvents: readBurnEvents ?? (async () => ({ events: [], nextCursor: undefined })),
    upsertBySourceTx: (job) => store.upsertBySourceTx(job),
    // There is no separate queue: `next_attempt_at` on the row *is* the queue, and a freshly
    // inserted row defaults to due immediately. So enqueueing is a no-op beyond the insert that
    // already happened — which is also why the insert must come first, as it does in
    // `scanForBurns`.
    enqueue: async () => undefined,
    loadCursor: () => cursors.load(),
    saveCursor: (cursor) => cursors.save(cursor),
    sourceDomainId,
    newJobId: () => crypto.randomUUID(),
    now: () => Date.now(),
    log: (message, fields) => console.log(`[relay] ${message}`, fields ?? {}),
  };

  return {
    store,
    cursors,
    watcher,
    hasWatcher: Boolean(readBurnEvents),
    drain: {
      iris: createIrisClient(irisBaseUrl),
      mint,
      store,
      pollIntervalMs: 5_000,
      maxAttempts: 10,
      claimDueJobs: (limit: number, leaseMs: number) => store.claimDueJobs(limit, leaseMs),
      reschedule: store.reschedule.bind(store),
      log: (message: string, fields?: Record<string, unknown>) =>
        console.log(`[relay] ${message}`, fields ?? {}),
    },
  };
}
