import { describe, expect, it } from "vitest";
import { isOfferedRoute, normaliseTxHash, readDomain, readSource } from "./routes";

const STELLAR = 27;
const HEX = "ab".repeat(32);

describe("readSource", () => {
  it("means Stellar when no source is named, so every existing link still works", () => {
    expect(readSource(null, STELLAR)).toEqual({ domain: 27, kind: "stellar" });
    expect(readSource("", STELLAR)).toEqual({ domain: 27, kind: "stellar" });
    expect(readSource("27", STELLAR)).toEqual({ domain: 27, kind: "stellar" });
  });

  it("accepts the EVM chains this product burns on", () => {
    for (const domain of [0, 1, 2, 3, 6, 7, 10, 11, 12, 13, 14, 15, 16, 18, 19, 21, 22, 26, 28]) {
      expect(readSource(String(domain), STELLAR)).toEqual({ domain, kind: "evm" });
    }
  });

  it("refuses a chain we do not burn on, and anything that is not a domain", () => {
    // 5 is Solana: a destination here, never a source. 8 (Sui) and 29 are Circle domains we do
    // not burn on.
    for (const bad of ["5", "8", "29", "999", "-1", "0x6", "base", "6;", " 6"]) {
      expect(readSource(bad, STELLAR), bad).toBeNull();
    }
  });
});

describe("normaliseTxHash", () => {
  it("takes a Stellar hash bare and an EVM hash with 0x, lower-cased", () => {
    expect(normaliseTxHash("stellar", ` ${HEX.toUpperCase()} `)).toBe(HEX);
    expect(normaliseTxHash("evm", `0x${HEX.toUpperCase()}`)).toBe(`0x${HEX}`);
  });

  it("does not accept either in the other's form", () => {
    expect(normaliseTxHash("stellar", `0x${HEX}`)).toBeNull();
    expect(normaliseTxHash("evm", HEX)).toBeNull();
  });

  it("refuses the wrong length, non-hex and nothing", () => {
    for (const bad of [
      null,
      undefined,
      "",
      "zz",
      HEX.slice(2),
      `${HEX}00`,
      `0x${"zz".repeat(32)}`,
    ]) {
      expect(normaliseTxHash("stellar", bad)).toBeNull();
      expect(normaliseTxHash("evm", bad)).toBeNull();
    }
  });
});

describe("isOfferedRoute", () => {
  it("offers the wrapper's two Stellar routes", () => {
    expect(isOfferedRoute(27, 5, STELLAR)).toBe(true);
    expect(isOfferedRoute(27, 26, STELLAR)).toBe(true);
    expect(isOfferedRoute(27, 6, STELLAR)).toBe(false);
  });

  it("offers each EVM peer with Arc, both ways, and nothing between peers", () => {
    expect(isOfferedRoute(6, 26, STELLAR)).toBe(true);
    expect(isOfferedRoute(26, 0, STELLAR)).toBe(true);
    expect(isOfferedRoute(6, 3, STELLAR)).toBe(false);
    expect(isOfferedRoute(6, 5, STELLAR)).toBe(false);
    // Arc sends to Solana; Solana is never a source here.
    expect(isOfferedRoute(26, 5, STELLAR)).toBe(true);
    expect(isOfferedRoute(5, 26, STELLAR)).toBe(false);
    // EDGE (28) and Linea (11), both directions.
    expect(isOfferedRoute(28, 26, STELLAR)).toBe(true);
    expect(isOfferedRoute(26, 11, STELLAR)).toBe(true);
    expect(isOfferedRoute(26, 27, STELLAR)).toBe(false);
  });
});

describe("readDomain", () => {
  it("reads digits only", () => {
    expect(readDomain("26")).toBe(26);
    expect(readDomain("0")).toBe(0);
    expect(readDomain(null)).toBeNull();
    expect(readDomain("2 6")).toBeNull();
    expect(readDomain("1e2")).toBeNull();
  });
});
