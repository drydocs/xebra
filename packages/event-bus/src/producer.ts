import { CHAIN_EVENTS_TOPIC, type ChainEvent } from "./types.js";

/**
 * Narrow structural interface, not kafkajs's own `Producer` type — real production code passes
 * `kafka.producer()` (which satisfies this shape), tests pass a plain mock object. Keeps this
 * package's public API decoupled from kafkajs's exact types.
 */
export interface KafkaProducerLike {
  connect(): Promise<void>;
  send(record: { topic: string; messages: { key: string; value: string }[] }): Promise<unknown>;
  disconnect(): Promise<void>;
}

export interface EventProducer {
  publish(event: ChainEvent): Promise<void>;
  disconnect(): Promise<void>;
}

export function createEventProducer(producer: KafkaProducerLike): EventProducer {
  let connected = false;

  async function ensureConnected() {
    if (!connected) {
      await producer.connect();
      connected = true;
    }
  }

  return {
    async publish(event) {
      await ensureConnected();
      await producer.send({
        topic: CHAIN_EVENTS_TOPIC,
        messages: [{ key: event.id, value: JSON.stringify(event) }],
      });
    },
    async disconnect() {
      if (connected) {
        await producer.disconnect();
        connected = false;
      }
    },
  };
}
