import { describe, expect, it } from "vitest";
import { readDestinationDomain } from "./message.js";

/** A V2 header: version 1, source domain 27, then the destination under test. */
function message(destination: number): `0x${string}` {
  const u32 = (n: number) => n.toString(16).padStart(8, "0");
  return `0x${u32(1)}${u32(27)}${u32(destination)}${"00".repeat(64)}`;
}

describe("readDestinationDomain", () => {
  it("reads the destination out of the V2 header", () => {
    expect(readDestinationDomain(message(5))).toBe(5);
    expect(readDestinationDomain(message(26))).toBe(26);
  });

  it("does not confuse the source domain with the destination", () => {
    expect(readDestinationDomain(message(0))).toBe(0);
  });

  it("refuses something that is not a message", () => {
    expect(() => readDestinationDomain("0x0000")).toThrow("not a CCTP message");
    expect(() => readDestinationDomain(`0x${"zz".repeat(20)}`)).toThrow("not a CCTP message");
  });
});
