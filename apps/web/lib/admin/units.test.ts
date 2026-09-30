import { describe, expect, it } from "vitest";
import { bpsToField, fieldToBps, fieldToStroops, stroopsToField } from "./units";

describe("usdc fields", () => {
  it("round-trips the live values", () => {
    for (const s of [0n, 3_000_000n, 10_000_000n, 1_000_000_000n, 2_500_000n, 1n]) {
      expect(fieldToStroops(stroopsToField(s))).toBe(s);
    }
    expect(stroopsToField(3_000_000n)).toBe("0.3");
    expect(stroopsToField(1_000_000_000n)).toBe("100");
  });
  it("rejects junk and over-precision", () => {
    for (const bad of ["", "abc", "-1", "1.23456789", "1,5", ".", "1e3"]) {
      expect(fieldToStroops(bad)).toBeNull();
    }
  });
  it("accepts 7 places and a bare integer", () => {
    expect(fieldToStroops("0.0000001")).toBe(1n);
    expect(fieldToStroops("5")).toBe(50_000_000n);
  });
});

describe("bps fields", () => {
  it("converts", () => {
    expect(bpsToField(10)).toBe("0.10");
    expect(fieldToBps("0.10")).toBe(10);
    expect(fieldToBps("1")).toBe(100);
    expect(fieldToBps("0.5")).toBe(50);
  });
  it("refuses finer than a basis point", () => {
    expect(fieldToBps("0.105")).toBeNull();
    expect(fieldToBps("x")).toBeNull();
  });
});
