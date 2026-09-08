import { type rpc, scValToNative } from "@stellar/stellar-sdk";
import { BRIDGE_INITIATED_TOPIC, type BurnEvent } from "./burn-watcher.js";

/**
 * Reads `bridge_initiated` events off Soroban RPC for the burn watcher.
 *
 * # Why this filters by topic even though the RPC filter already does
 *
 * `getEvents` is asked for `contract` events on the wrapper contract only, so in principle
 * everything it returns is ours. It is filtered again here because the wrapper emits several
 * *other* events — `params_proposed`, `fee_recipient_proposed`, `paused` — and relaying one of
 * those as if it were a burn would queue a mint for a transaction that burned nothing. The mint
 * would fail at Iris ("no message for this transaction") after however many retries the backoff
 * allows, so the cost of getting this wrong is retry noise rather than lost funds, but the
 * filter is one line.
 *
 * The topic is snake_case. Soroban's `#[contractevent]` derives it from the struct name that
 * way, and this repo has already shipped a bug from assuming PascalCase — see the note in
 * `packages/chain-adapters/src/stellar/decode-soroban-events.ts`.
 *
 * # Why the source chain's transaction hash is the only field taken
 *
 * The relay does not need the amount, the recipient or the fee: Circle's Iris API is keyed on
 * the burn transaction, and the attested message carries all of it, signed. Reading those
 * fields off the event and trusting them would mean the relay could mint against numbers a
 * malicious RPC supplied. The hash is the one field that is checkable — Iris will simply not
 * return a message for a transaction that did not burn.
 *
 * # `startLedger` and the retention window
 *
 * Soroban RPC keeps only a limited window of events (mainnet: about 24 hours). `startLedger` is
 * therefore a first-run bootstrap only; after that the persisted cursor is authoritative. A
 * relay that has been down longer than the retention window cannot recover the burns it missed
 * from the RPC at all — they have to be re-submitted by hash through `submitBurn`, which is one
 * of the reasons that path exists.
 */

export interface SorobanEventReader {
  getEvents(cursor: string | undefined): Promise<rpc.Api.GetEventsResponse>;
}

/** Pulls the burn events out of one `getEvents` page. Separated from the RPC call so the
 *  filtering can be tested without a network or an `rpc.Server`. */
export function toBurnEvents(events: rpc.Api.EventResponse[]): BurnEvent[] {
  const burns: BurnEvent[] = [];
  for (const event of events) {
    const first = event.topic[0];
    if (!first) continue;
    let topicName: unknown;
    try {
      topicName = scValToNative(first);
    } catch {
      // A topic that will not decode is not one of ours. Skipping is right: throwing here
      // would stall the whole batch, and with it every burn behind it in the page.
      continue;
    }
    if (topicName !== BRIDGE_INITIATED_TOPIC) continue;
    burns.push({ txHash: event.txHash });
  }
  return burns;
}

export function createSorobanBurnSource(
  reader: SorobanEventReader,
): (cursor: string | undefined) => Promise<{ events: BurnEvent[]; nextCursor: string | undefined }> {
  return async (cursor) => {
    const response = await reader.getEvents(cursor);
    return { events: toBurnEvents(response.events), nextCursor: response.cursor };
  };
}

/** Wires the real `rpc.Server`. `startLedger` applies only until the first cursor is saved. */
export function createRpcEventReader(
  server: rpc.Server,
  contractId: string,
  startLedger: number,
): SorobanEventReader {
  return {
    async getEvents(cursor) {
      return server.getEvents({
        filters: [{ type: "contract", contractIds: [contractId] }],
        // `getEvents` rejects a request carrying both, so this is exclusive, not a merge.
        ...(cursor ? { cursor } : { startLedger }),
        limit: 100,
      });
    },
  };
}
