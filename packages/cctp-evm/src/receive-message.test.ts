import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import { encodeReceiveMessage, messageTransmitterAbi } from "./receive-message.js";

describe("encodeReceiveMessage", () => {
  it("encodes MessageTransmitterV2.receiveMessage(bytes,bytes)", () => {
    const data = encodeReceiveMessage("0xdeadbeef", "0xcafe");
    // 0x57ecfd28 is the V2 receiveMessage selector on every CCTP EVM chain.
    expect(data.startsWith("0x57ecfd28")).toBe(true);
    const decoded = decodeFunctionData({ abi: messageTransmitterAbi, data });
    expect(decoded.functionName).toBe("receiveMessage");
    expect(decoded.args).toEqual(["0xdeadbeef", "0xcafe"]);
  });
});
