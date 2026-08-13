import { describe, expect, it, vi } from "vitest";
import { type KafkaProducerLike, createEventProducer } from "./producer.js";
import { CHAIN_EVENTS_TOPIC, type ChainEvent } from "./types.js";

function mockProducer(): KafkaProducerLike {
  return {
    connect: vi.fn(async () => {}),
    send: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
  };
}

const EVENT: ChainEvent = {
  id: "2:0xabc:0",
  chainId: 2,
  intentHash: "0xdead",
  eventType: "IntentOpened",
  txRef: "0xabc",
  blockOrLedgerNumber: "123",
  observedAt: new Date().toISOString(),
  payload: { sourceAmount: "100" },
};

describe("createEventProducer", () => {
  it("connects lazily, once, on first publish", async () => {
    const kafkaProducer = mockProducer();
    const producer = createEventProducer(kafkaProducer);

    await producer.publish(EVENT);
    await producer.publish(EVENT);

    expect(kafkaProducer.connect).toHaveBeenCalledTimes(1);
    expect(kafkaProducer.send).toHaveBeenCalledTimes(2);
  });

  it("publishes to the chain-events topic, keyed by the event id", async () => {
    const kafkaProducer = mockProducer();
    const producer = createEventProducer(kafkaProducer);

    await producer.publish(EVENT);

    expect(kafkaProducer.send).toHaveBeenCalledWith({
      topic: CHAIN_EVENTS_TOPIC,
      messages: [{ key: EVENT.id, value: JSON.stringify(EVENT) }],
    });
  });

  it("disconnect() is a no-op if never connected", async () => {
    const kafkaProducer = mockProducer();
    const producer = createEventProducer(kafkaProducer);

    await producer.disconnect();

    expect(kafkaProducer.disconnect).not.toHaveBeenCalled();
  });
});
