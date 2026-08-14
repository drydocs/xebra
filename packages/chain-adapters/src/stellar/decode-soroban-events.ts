import { type rpc, scValToNative } from "@stellar/stellar-sdk";
import type { ChainEvent, ChainEventType } from "@xebra/event-bus";
import { ChainId } from "@xebra/intent-schema";

/**
 * Decodes Soroban RPC `getEvents()` results from the new (Stellar-as-source) XebraEscrow
 * contract into normalized `ChainEvent`s, consumed by apps/indexer-stellar.
 *
 * Field shapes here (`EventResponse.topic`/`value` as `xdr.ScVal[]`/`xdr.ScVal`, `txHash`,
 * `ledger`, `ledgerClosedAt`, `id`) are verified against @stellar/stellar-sdk's real
 * `rpc.Api.EventResponse` type (compiled against, not guessed), and — as of
 * scripts/e2e-demo — against real events emitted by a live testnet deployment. That live check
 * caught a real bug: `#[contractevent]`'s topic is the struct name in **snake_case**
 * (`intent_opened`, not `IntentOpened`) — the original `EVENT_TOPIC_TO_TYPE` keys were PascalCase
 * and silently matched zero events. `scValToNative` returns a Node `Buffer` (a `Uint8Array`
 * subclass) for `BytesN`/`Bytes` fields, confirmed against the same live events, which is what
 * `serializeNative`'s `instanceof Uint8Array` check below was written to catch.
 */

const EVENT_TOPIC_TO_TYPE: Record<string, ChainEventType> = {
  intent_opened: "IntentOpened",
  intent_claimed: "IntentClaimed",
  intent_challenged: "IntentChallenged",
  intent_resolved: "IntentResolved",
  intent_finalized: "IntentFinalized",
  intent_refunded: "IntentRefunded",
};

const INTENT_HASH_KEYS = ["intent_hash", "intentHash"];

export function decodeSorobanEvents(events: rpc.Api.EventResponse[]): ChainEvent[] {
  const result: ChainEvent[] = [];

  for (const event of events) {
    const topics = event.topic.map((topic) => scValToNative(topic));
    const topicName = typeof topics[0] === "string" ? topics[0] : undefined;
    const eventType = topicName ? EVENT_TOPIC_TO_TYPE[topicName] : undefined;
    if (!eventType) continue; // not a Xebra event this indexer recognizes

    const data = serializeNative(scValToNative(event.value));
    const intentHash = extractIntentHash(data);

    result.push({
      id: `${ChainId.Stellar}:${event.txHash}:${event.id}`,
      chainId: ChainId.Stellar,
      intentHash,
      eventType,
      txRef: event.txHash,
      blockOrLedgerNumber: String(event.ledger),
      observedAt: event.ledgerClosedAt,
      payload:
        typeof data === "object" && data !== null
          ? (data as Record<string, unknown>)
          : { value: data },
    });
  }

  return result;
}

function extractIntentHash(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  for (const key of INTENT_HASH_KEYS) {
    const value = (data as Record<string, unknown>)[key];
    if (typeof value === "string") return value;
  }
  return null;
}

/** bigints and raw byte buffers aren't JSON-serializable as-is; recurse through nested
 *  objects/arrays since a decoded event's data is a whole struct, not a flat record. */
function serializeNative(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) return bytesToHex(value);
  if (Array.isArray(value)) return value.map(serializeNative);
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = serializeNative(val);
    }
    return out;
  }
  return value;
}

function bytesToHex(bytes: Uint8Array): string {
  let hex = "0x";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}
