import { type Hex, encodeFunctionData, parseAbi } from "viem";

/**
 * CCTP V2 `MessageTransmitterV2.receiveMessage(bytes message, bytes attestation) returns (bool)`.
 *
 * Permissionless by design: Circle's contract checks the attestation, the destination domain and
 * `destinationCaller` (zero for every Xebra burn, meaning *anyone* may submit). That is why the
 * user's own wallet can send it on `/claim`.
 */
export const messageTransmitterAbi = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool success)",
  "function usedNonces(bytes32 nonce) view returns (uint256)",
]);

/** Calldata for a wallet to send: what the browser claim path submits on `/claim`. */
export function encodeReceiveMessage(message: Hex, attestation: Hex): Hex {
  return encodeFunctionData({
    abi: messageTransmitterAbi,
    functionName: "receiveMessage",
    args: [message, attestation],
  });
}
