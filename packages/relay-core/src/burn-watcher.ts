import { type RelayJobState, createQueuedJob } from "@xebra/cctp-client";

/**
 * Turns Stellar burns into relay jobs.
 *
 * # The gap this closes
 *
 * `enqueueRelayJob` existed and was never called by anything. The queue, the backoff, the state
 * machine and (now) the mint were all real, and no burn ever entered any of it — the relay
 * would have sat idle forever with a working mint path.
 *
 * # Why it watches our wrapper, not Circle's contract
 *
 * Circle's TokenMessengerMinter emits a burn event for *every* CCTP user on Stellar, not just
 * ours. Relaying all of them would mean paying rent and fees to mint strangers' transfers.
 *
 * So the watcher keys off `bridge_initiated`, emitted by `contracts/stellar-cctp-wrapper` —
 * every burn it sees is one we were paid a fee for. Until that contract is deployed the app
 * bridges directly through Circle, and those burns have nothing distinguishing them on chain;
 * `submitBurn` exists for that case, so the frontend can hand us a transaction hash it just
 * signed.
 *
 * # Idempotency
 *
 * Soroban event cursors overlap on restart, and a crash mid-batch re-reads the same ledgers.
 * Every path goes through `upsertBySourceTx`, whose unique index on
 * `(source_domain_id, source_tx_hash)` makes a repeat a no-op. Without it a re-scan would
 * queue a second mint for a burn already minted, which the chain rejects via `used_nonce` —
 * correctly, but only after charging a fee to find out.
 */

/** Emitted by the wrapper. Topic is snake_case: Soroban `#[contractevent]` names are, and this
 *  repo has already shipped a bug from assuming PascalCase. */
export const BRIDGE_INITIATED_TOPIC = "bridge_initiated";

export interface BurnEvent {
  /** Stellar transaction hash of the burn — the natural key for the whole transfer. */
  txHash: string;
}

export interface BurnWatcherDeps {
  /**
   * Reads `bridge_initiated` events from the wrapper contract. The cursor is Soroban RPC's
   * own opaque pagination token, not a ledger number — `getEvents` returns it and expects it
   * back verbatim.
   */
  readBurnEvents(cursor: string | undefined): Promise<{
    events: BurnEvent[];
    nextCursor: string | undefined;
  }>;
  /** Persists a job, returning `created: false` if this burn was already queued. */
  upsertBySourceTx(job: RelayJobState): Promise<{ job: RelayJobState; created: boolean }>;
  /** Hands the job to the queue for attestation polling and minting. */
  enqueue(job: RelayJobState): Promise<void>;
  /** Cursor persistence, so a restart does not re-scan from genesis or skip a gap. */
  loadCursor(): Promise<string | undefined>;
  saveCursor(cursor: string): Promise<void>;
  /** CCTP domain of the source chain — 27 for Stellar. */
  sourceDomainId: number;
  newJobId(): string;
  now(): number;
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface WatchResult {
  cursor: string | undefined;
  queued: number;
  duplicates: number;
}

/**
 * One scan pass. Returns counts rather than looping internally so the caller owns the schedule
 * and the process can be shut down cleanly between passes.
 */
export async function scanForBurns(deps: BurnWatcherDeps): Promise<WatchResult> {
  const cursor = await deps.loadCursor();
  const { events, nextCursor } = await deps.readBurnEvents(cursor);

  let queued = 0;
  let duplicates = 0;

  for (const event of events) {
    const job = createQueuedJob(
      {
        id: deps.newJobId(),
        sourceDomainId: deps.sourceDomainId,
        sourceTxHash: event.txHash,
      },
      deps.now(),
    );

    const { job: stored, created } = await deps.upsertBySourceTx(job);
    if (!created) {
      duplicates++;
      continue;
    }

    // Enqueue only after the row is committed. The reverse order would let a crash between
    // enqueue and insert leave a queue entry with no durable state behind it — the exact
    // failure the Postgres store exists to prevent.
    await deps.enqueue(stored);
    queued++;
    deps.log?.("queued mint for burn", { txHash: event.txHash, jobId: stored.id });
  }

  // Advance the cursor only after everything in the batch is durable. Re-scanning is free
  // (duplicates are no-ops); skipping a range strands a transfer.
  //
  // `||`, not `??`: Soroban returns an empty-string cursor when there was no pagination
  // progress, and treating that as a real value would reset the watcher to the beginning.
  const advanced = nextCursor || cursor;
  if (advanced) await deps.saveCursor(advanced);

  return { cursor: advanced, queued, duplicates };
}

/**
 * Queues a burn the caller already knows about, by transaction hash.
 *
 * Used for direct-mode transfers, where the app burns straight through Circle's contract and
 * nothing on chain marks the burn as ours. Also the manual recovery path: given any Stellar
 * burn hash, this queues a mint for it.
 */
export async function submitBurn(
  deps: Pick<
    BurnWatcherDeps,
    "upsertBySourceTx" | "enqueue" | "sourceDomainId" | "newJobId" | "now" | "log"
  >,
  txHash: string,
): Promise<{ job: RelayJobState; created: boolean }> {
  const result = await deps.upsertBySourceTx(
    createQueuedJob(
      {
        id: deps.newJobId(),
        sourceDomainId: deps.sourceDomainId,
        sourceTxHash: txHash,
      },
      deps.now(),
    ),
  );

  if (result.created) {
    await deps.enqueue(result.job);
    deps.log?.("queued mint for submitted burn", { txHash, jobId: result.job.id });
  }
  return result;
}
