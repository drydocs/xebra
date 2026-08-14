import type {
  GetPublicKeyCommand,
  GetPublicKeyCommandOutput,
  SignCommand,
  SignCommandOutput,
} from "@aws-sdk/client-kms";

/**
 * Narrow structural interface, not the full `KMSClient` class — production code passes a real
 * `KMSClient` instance (which satisfies this shape), tests pass a plain mock. Same decoupling
 * pattern as packages/event-bus's `KafkaProducerLike`/`KafkaConsumerLike`.
 */
export interface KmsClientLike {
  send(command: GetPublicKeyCommand): Promise<GetPublicKeyCommandOutput>;
  send(command: SignCommand): Promise<SignCommandOutput>;
}
