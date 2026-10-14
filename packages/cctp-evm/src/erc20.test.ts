import { decodeFunctionData } from "viem";
import { describe, expect, it } from "vitest";
import {
  decodeUint256,
  encodeAllowance,
  encodeApprove,
  encodeBalanceOf,
  erc20Abi,
} from "./erc20.js";

const OWNER = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d";

describe("ERC-20 calldata", () => {
  it("encodes the three standard selectors", () => {
    expect(encodeBalanceOf(OWNER).startsWith("0x70a08231")).toBe(true);
    expect(encodeAllowance(OWNER, SPENDER).startsWith("0xdd62ed3e")).toBe(true);
    expect(encodeApprove(SPENDER, 1n).startsWith("0x095ea7b3")).toBe(true);
  });

  it("approves exactly the amount asked for, to the spender named", () => {
    const { args } = decodeFunctionData({
      abi: erc20Abi,
      data: encodeApprove(SPENDER, 5_000_000n),
    });
    expect(args).toEqual([SPENDER, 5_000_000n]);
  });

  it("refuses to encode an approval for nothing", () => {
    expect(() => encodeApprove(SPENDER, 0n)).toThrow("amount must be positive");
  });
});

describe("decodeUint256", () => {
  it("reads a 32-byte word", () => {
    expect(decodeUint256(`0x${"00".repeat(31)}05`)).toBe(5n);
    expect(decodeUint256(`0x${"00".repeat(32)}`)).toBe(0n);
  });

  it("refuses an empty result instead of calling it zero", () => {
    // `0x` is what a call to an address with no code returns: the wrong chain, not an empty wallet.
    expect(() => decodeUint256("0x")).toThrow("returned no value");
    expect(() => decodeUint256(null)).toThrow("returned no value");
    expect(() => decodeUint256("0x05")).toThrow("returned no value");
  });
});
