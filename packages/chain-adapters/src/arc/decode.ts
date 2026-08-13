import type { ChainEvent, ChainEventType } from "@xebra/event-bus";
import { ChainId } from "@xebra/intent-schema";
import { type Log, parseEventLogs } from "viem";
import { XEBRA_ESCROW_ABI } from "./abi.js";

/**
 * Decodes raw Arc (EVM) logs from `XebraEscrow` into normalized `ChainEvent`s, consumed by
 * apps/indexer-arc. Kept as a pure function — `apps/indexer-arc`'s only job is fetching logs
 * (via `viem`'s `watchContractEvent`/`getLogs`) and handing them here; all the actual decoding
 * logic lives in this package so it's testable without a live chain (see decode.live.test.ts
 * for the one live-chain proof this still gets, against a real anvil-deployed contract).
 */

const EVENT_NAMES: readonly ChainEventType[] = [
  "IntentOpened",
  "IntentClaimed",
  "IntentChallenged",
  "IntentResolved",
  "IntentFinalized",
  "IntentRefunded",
];

type ParsedArcLog = ReturnType<typeof parseEventLogs<typeof XEBRA_ESCROW_ABI>>[number];

export function decodeArcLogs(logs: Log[]): ChainEvent[] {
  const parsed = parseEventLogs({ abi: XEBRA_ESCROW_ABI, logs });
  return parsed.map(normalizeArcLog);
}

function normalizeArcLog(log: ParsedArcLog): ChainEvent {
  const eventType = EVENT_NAMES.find((name) => name === log.eventName);
  if (!eventType) {
    throw new Error(`decodeArcLogs: unrecognized event "${log.eventName}"`);
  }

  const args = log.args as Record<string, unknown>;
  const intentHash = typeof args.intentHash === "string" ? args.intentHash : null;
  const txRef = log.transactionHash ?? "";

  return {
    id: `${ChainId.ArcEvm}:${txRef}:${log.logIndex ?? 0}`,
    chainId: ChainId.ArcEvm,
    intentHash,
    eventType,
    txRef,
    blockOrLedgerNumber: log.blockNumber != null ? log.blockNumber.toString() : null,
    observedAt: new Date().toISOString(),
    payload: serializeArgs(args),
  };
}

/** bigint args (amounts, timestamps, nonces) aren't JSON-serializable as-is. */
function serializeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = typeof value === "bigint" ? value.toString() : value;
  }
  return out;
}
