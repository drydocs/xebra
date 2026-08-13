import { CHAIN_EVENTS_TOPIC, type ChainEvent } from "./types.js";

export interface KafkaMessageLike {
  value: Buffer | string | null;
}

export interface KafkaConsumerLike {
  connect(): Promise<void>;
  subscribe(opts: { topic: string; fromBeginning?: boolean }): Promise<void>;
  run(opts: {
    eachMessage: (payload: { message: KafkaMessageLike }) => Promise<void>;
  }): Promise<void>;
  disconnect(): Promise<void>;
}

export interface EventConsumerHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Malformed/unparseable messages are dropped and reported via `onError` rather than crashing
 *  the consumer loop — one bad message shouldn't take down the whole subscriber. */
export function createEventConsumer(
  consumer: KafkaConsumerLike,
  onEvent: (event: ChainEvent) => Promise<void>,
  onError: (err: unknown, rawValue: string | null) => void = console.error,
): EventConsumerHandle {
  return {
    async start() {
      await consumer.connect();
      await consumer.subscribe({ topic: CHAIN_EVENTS_TOPIC, fromBeginning: false });
      await consumer.run({
        eachMessage: async ({ message }) => {
          if (message.value == null) return;
          const raw = message.value.toString();
          try {
            const event = JSON.parse(raw) as ChainEvent;
            await onEvent(event);
          } catch (err) {
            onError(err, raw);
          }
        },
      });
    },
    async stop() {
      await consumer.disconnect();
    },
  };
}
