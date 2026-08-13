import { describe, expect, it, vi } from "vitest";
import { type KafkaConsumerLike, createEventConsumer } from "./consumer.js";
import { CHAIN_EVENTS_TOPIC, type ChainEvent } from "./types.js";

const EVENT: ChainEvent = {
  id: "2:0xabc:0",
  chainId: 2,
  intentHash: "0xdead",
  eventType: "IntentOpened",
  txRef: "0xabc",
  blockOrLedgerNumber: "123",
  observedAt: new Date().toISOString(),
  payload: {},
};

function mockConsumer(): {
  consumer: KafkaConsumerLike;
  deliver: (value: string | null) => Promise<void>;
} {
  let handler: ((payload: { message: { value: string | null } }) => Promise<void>) | undefined;
  const consumer: KafkaConsumerLike = {
    connect: vi.fn(async () => {}),
    subscribe: vi.fn(async () => {}),
    run: vi.fn(async ({ eachMessage }) => {
      handler = eachMessage;
    }),
    disconnect: vi.fn(async () => {}),
  };
  return {
    consumer,
    deliver: async (value) => {
      if (!handler) throw new Error("consumer.run() was never called");
      await handler({ message: { value } });
    },
  };
}

describe("createEventConsumer", () => {
  it("subscribes to the chain-events topic and forwards parsed events to onEvent", async () => {
    const { consumer, deliver } = mockConsumer();
    const onEvent = vi.fn(async () => {});
    const handle = createEventConsumer(consumer, onEvent);

    await handle.start();
    expect(consumer.subscribe).toHaveBeenCalledWith({
      topic: CHAIN_EVENTS_TOPIC,
      fromBeginning: false,
    });

    await deliver(JSON.stringify(EVENT));
    expect(onEvent).toHaveBeenCalledWith(EVENT);
  });

  it("skips null message values without calling onEvent", async () => {
    const { consumer, deliver } = mockConsumer();
    const onEvent = vi.fn(async () => {});
    const handle = createEventConsumer(consumer, onEvent);
    await handle.start();

    await deliver(null);

    expect(onEvent).not.toHaveBeenCalled();
  });

  it("routes a malformed message to onError instead of throwing", async () => {
    const { consumer, deliver } = mockConsumer();
    const onEvent = vi.fn(async () => {});
    const onError = vi.fn();
    const handle = createEventConsumer(consumer, onEvent, onError);
    await handle.start();

    await deliver("{not valid json");

    expect(onEvent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "{not valid json");
  });

  it("stop() disconnects the underlying consumer", async () => {
    const { consumer } = mockConsumer();
    const handle = createEventConsumer(consumer, vi.fn());
    await handle.stop();
    expect(consumer.disconnect).toHaveBeenCalledOnce();
  });
});
