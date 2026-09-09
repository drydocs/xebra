import { rpc, scValToNative } from "@stellar/stellar-sdk";
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

/**
 * The same thing from a URL, so a caller needs no Stellar SDK of its own.
 *
 * Both deployment shells — the standalone relay and a Vercel route — otherwise had to depend on
 * @stellar/stellar-sdk purely to construct one client. On Vercel that also matters for bundle
 * size: the SDK is large, and a route that only reads events should not pull in transaction
 * building and signing.
 */
export function createBurnReaderFromUrl(
  rpcUrl: string,
  contractId: string,
  startLedger: number,
): (cursor: string | undefined) => Promise<{
  events: BurnEvent[];
  nextCursor: string | undefined;
}> {
  return createSorobanBurnSource(createRpcEventReader(new rpc.Server(rpcUrl), contractId, startLedger));
}

/**
 * When a Stellar transaction closed, from Horizon, or `undefined` if it is unknown.
 *
 * Horizon rather than Soroban RPC: Soroban RPC's `getTransaction` keeps only a short retention
 * window and, on SDK 13 against protocol 23, throws `Bad union switch: 4` on its own response —
 * a mismatch this repo has already been bitten by. Horizon's REST shape is stable and needs no
 * XDR decoding for a timestamp.
 *
 * A 404 is `undefined`, not an error: an unknown hash is a normal answer to "is this a burn?".
 * Any other failure throws, because "Horizon is down" must not be reported as "no such burn" —
 * that distinction is exactly the bug that made a valid transfer look invalid once already.
 */
export function createHorizonBurnClock(horizonUrl: string): (txHash: string) => Promise<number | undefined> {
  return async (txHash) => {
    // No `cache` option: this package is compiled against Node's own `fetch` types, which do
    // not carry it. Horizon does not send cacheable headers for a transaction lookup anyway, and
    // on Vercel the route handlers that call this are already `force-dynamic`.
    const res = await fetch(new URL(`/transactions/${txHash}`, horizonUrl));
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`Horizon returned ${res.status} for transaction ${txHash}`);
    const body = (await res.json()) as { created_at?: string };
    const closedAt = body.created_at ? Date.parse(body.created_at) : Number.NaN;
    return Number.isNaN(closedAt) ? undefined : closedAt;
  };
}
