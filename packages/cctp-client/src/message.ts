/**
 * Reads the destination domain out of a CCTP V2 message.
 *
 * The destination is in the one artifact a mint cannot happen without — Circle's attested message —
 * and it is the copy Circle's contracts enforce: a `receiveMessage` for the wrong domain reverts on
 * chain no matter what we believed. So the page reads it from here rather than trusting a second
 * field that could drift from it.
 *
 * CCTP V2 message header, big-endian: `version(4) | sourceDomain(4) | destinationDomain(4) |
 * nonce(32) | sender(32) | recipient(32) | destinationCaller(32) | ...`.
 */

const DESTINATION_DOMAIN_OFFSET = 8;
const HEADER_MIN_BYTES = DESTINATION_DOMAIN_OFFSET + 4;

export function readDestinationDomain(message: `0x${string}`): number {
  const hex = message.slice(2);
  if (hex.length < HEADER_MIN_BYTES * 2 || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("not a CCTP message: too short or not hex");
  }
  const start = DESTINATION_DOMAIN_OFFSET * 2;
  return Number.parseInt(hex.slice(start, start + 8), 16);
}

/**
 * CCTP V2 layout past the destination, big-endian. The header is 148 bytes:
 * `... | nonce(32) @12 | sender(32) | recipient(32) | destinationCaller(32) |
 * minFinalityThreshold(4) | finalityThresholdExecuted(4)`, and the burn message body follows:
 * `version(4) | burnToken(32) | mintRecipient(32) | amount(32) | messageSender(32) | maxFee(32) |
 * feeExecuted(32) | expirationBlock(32) @344 | hookData`.
 *
 * The offsets are pinned by a test against a message Circle attested on mainnet.
 */
const NONCE_OFFSET = 12;
const EXPIRATION_BLOCK_OFFSET = 344;

function word(message: `0x${string}`, offset: number): string {
  const hex = message.slice(2);
  const end = (offset + 32) * 2;
  if (hex.length < end || !/^[0-9a-fA-F]*$/.test(hex)) {
    throw new Error("not a CCTP message: too short or not hex");
  }
  return hex.slice(offset * 2, end);
}

/** The nonce Circle's transmitter marks as used once the message is minted. */
export function readNonce(message: `0x${string}`): `0x${string}` {
  return `0x${word(message, NONCE_OFFSET)}`;
}

/**
 * The destination-chain block after which this message can no longer be minted, or `0n` for one
 * that never expires.
 *
 * Only a Fast burn carries one: Circle attests it before the source chain has finalised, and
 * bounds how long that early attestation stays good. A Standard burn reads zero. An expired
 * message is not lost money; Circle re-attests it on request (`POST /v2/reattest/{nonce}`).
 */
export function readExpirationBlock(message: `0x${string}`): bigint {
  return BigInt(`0x${word(message, EXPIRATION_BLOCK_OFFSET)}`);
}
