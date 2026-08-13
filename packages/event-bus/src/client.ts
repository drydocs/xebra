import { Kafka, type KafkaConfig } from "kafkajs";

/** Thin factory around kafkajs's own client — the only file in this package that imports
 *  kafkajs's concrete classes. `producer.ts`/`consumer.ts` only depend on the narrow structural
 *  interfaces they define, so they stay testable without this. */
export function createKafkaClient(config: KafkaConfig) {
  return new Kafka(config);
}
