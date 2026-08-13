import { XEBRA_ESCROW_ABI, decodeArcLogs } from "@xebra/chain-adapters";
import type { EventProducer } from "@xebra/event-bus";
import type { Logger } from "pino";
import { http, type Log, type PublicClient, createPublicClient } from "viem";

/**
 * apps/indexer-arc — watches XebraEscrow on Arc, decodes logs via @xebra/chain-adapters
 * (proven against a real anvil-deployed contract, see that package's decode.live.test.ts), and
 * publishes normalized ChainEvents to the event backbone. This file is deliberately thin: the
 * only logic worth unit-testing on its own is `handleLogs`, which is separated from viem's live
 * `watchContractEvent` subscription for exactly that reason.
 */

export async function handleLogs(
  logs: Log[],
  producer: EventProducer,
  logger: Logger,
): Promise<void> {
  const events = decodeArcLogs(logs);
  for (const event of events) {
    await producer.publish(event);
    logger.info(
      { eventType: event.eventType, intentHash: event.intentHash },
      "indexer-arc: published event",
    );
  }
}

export function startWatching(
  rpcUrl: string,
  escrowAddress: `0x${string}`,
  producer: EventProducer,
  logger: Logger,
): { client: PublicClient; stop: () => void } {
  const client = createPublicClient({ transport: http(rpcUrl) });

  const unwatch = client.watchContractEvent({
    address: escrowAddress,
    abi: XEBRA_ESCROW_ABI,
    onLogs: (logs) => {
      handleLogs(logs, producer, logger).catch((err) => {
        logger.error({ err }, "indexer-arc: failed to handle logs");
      });
    },
    onError: (err) => {
      logger.error({ err }, "indexer-arc: watchContractEvent error");
    },
  });

  return { client, stop: unwatch };
}
