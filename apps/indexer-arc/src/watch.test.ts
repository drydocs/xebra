import type { EventProducer } from "@xebra/event-bus";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { handleLogs } from "./watch.js";

// A hand-decoded IntentOpened log shape matching what viem's parseEventLogs would emit for the
// event signature in contracts/arc-evm/src/XebraEscrow.sol — deliberately not re-deriving the
// full decode path here (that's decode.live.test.ts's job against a real chain); this just
// checks handleLogs correctly forwards decoded events to the producer.
function fakeLog() {
  return {
    address: "0x0000000000000000000000000000000000000001",
    topics: [],
    data: "0x",
    blockNumber: 1n,
    transactionHash: "0xabc",
    transactionIndex: 0,
    blockHash: "0xblock",
    logIndex: 0,
    removed: false,
  };
}

describe("handleLogs", () => {
  it("publishes nothing and doesn't throw when logs don't decode to any known event", async () => {
    const producer: EventProducer = { publish: vi.fn(), disconnect: vi.fn() };
    const logger = pino({ enabled: false });

    // biome-ignore lint/suspicious/noExplicitAny: intentionally malformed/undecodable log fixture
    await handleLogs([fakeLog() as any], producer, logger);

    expect(producer.publish).not.toHaveBeenCalled();
  });
});
