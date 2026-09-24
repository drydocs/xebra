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
