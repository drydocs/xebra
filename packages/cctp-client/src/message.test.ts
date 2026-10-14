import { describe, expect, it } from "vitest";
import { readDestinationDomain, readExpirationBlock, readNonce } from "./message.js";

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

/**
 * A real message: Stellar to Solana, attested and delivered by Circle on mainnet (burn
 * `cca4af89…cd7b3`, the transfer `scripts/smoke-prod.sh` checks). Standard finality, so it never
 * expires; Iris reports its `eventNonce` as the value below.
 */
const MAINNET_MESSAGE =
  "0x000000010000001b00000005903db3847105114c62d6f4d69f3780523dd557eb4fccfa1c95662eb4d214eef809a3773ffd1ff361f8315d629adf17d3e4730fd00a6900715431ed4b142aded2a65fc81d0fefa8860cb3b83f089b0224be8a6687b7ae49f594c0b9b4d7e938930000000000000000000000000000000000000000000000000000000000000000000007d0000007d000000001adefce59aee52968f76061d494c2525b75659fa4296a65f499ef29e56477e4961e7f7ed3b6de486f9ebf2833a6e50a119258a1e1f972154ea7d2ad33538dae860000000000000000000000000000000000000000000000000000000000387520a6a802b3d6321726794683981b6efb4595cba3ed022afda79c798d5cdd7045b00000000000000000000000000000000000000000000000000000000000050c110000000000000000000000000000000000000000000000000000000000050c110000000000000000000000000000000000000000000000000000000000000000636374702d666f7277617264000000000000000000000000000000000000002101a585d59e03fda49302a75520b46cb0b532ea9b326189de6aedf43a69cd030c68" as const;

describe("readNonce", () => {
  it("reads the nonce Circle reports for a real mainnet message", () => {
    expect(readNonce(MAINNET_MESSAGE)).toBe(
      "0x903db3847105114c62d6f4d69f3780523dd557eb4fccfa1c95662eb4d214eef8",
    );
    expect(readDestinationDomain(MAINNET_MESSAGE)).toBe(5);
  });

  it("refuses a message too short to hold one", () => {
    expect(() => readNonce(message(26))).not.toThrow();
    expect(() => readNonce("0x00000001")).toThrow("not a CCTP message");
  });
});

describe("readExpirationBlock", () => {
  it("reads zero for a Standard burn, which never expires", () => {
    expect(readExpirationBlock(MAINNET_MESSAGE)).toBe(0n);
  });

  it("reads the word just before the hook data, and not its neighbours", () => {
    // The same real message with only the expiration word changed. The word before it
    // (`feeExecuted`, 0x50c11) and the hook after it stay exactly as Circle attested them.
    const at = 2 + 344 * 2;
    const expiring =
      `${MAINNET_MESSAGE.slice(0, at)}${(12_345_678).toString(16).padStart(64, "0")}${MAINNET_MESSAGE.slice(at + 64)}` as `0x${string}`;
    expect(readExpirationBlock(expiring)).toBe(12_345_678n);
    expect(MAINNET_MESSAGE.slice(at - 64, at)).toMatch(/^0{59}50c11$/);
    expect(MAINNET_MESSAGE.slice(at + 64, at + 64 + 24)).toBe("636374702d666f7277617264");
  });

  it("refuses a header with no body", () => {
    expect(() => readExpirationBlock(message(26))).toThrow("not a CCTP message");
  });
});
