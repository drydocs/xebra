import { describe, expect, it } from "vitest";
import { formatError } from "./format-error.js";

describe("formatError", () => {
  it("never produces [object Object]", () => {
    // The regression this file exists for: a failed transfer showed literally this, which
    // destroyed the only evidence of what went wrong.
    const shapes: unknown[] = [
      {},
      { a: 1 },
      { status: "ERROR" },
      Object.create(null),
      new Map(),
      { toString: () => "[object Object]" },
    ];
    for (const shape of shapes) {
      expect(formatError(shape)).not.toBe("[object Object]");
    }
  });

  it("reads a Freighter-style nested error object", () => {
    expect(formatError({ error: { code: -4, message: "User declined access" } })).toBe(
      "User declined access",
    );
  });

  it("reads a bare message object", () => {
    expect(formatError({ message: "Trustline missing" })).toBe("Trustline missing");
  });

  it("summarises a stellar-sdk sendTransaction failure", () => {
    const out = formatError({
      status: "ERROR",
      hash: "abc123",
      errorResult: { code: "txInsufficientBalance" },
    });
    expect(out).toContain("status ERROR");
    expect(out).toContain("abc123");
    expect(out).toContain("txInsufficientBalance");
  });

  it("uses an Error's message", () => {
    expect(formatError(new Error("boom"))).toBe("boom");
  });

  it("appends a cause when the outer message is uninformative", () => {
    const err = new Error("Failed", { cause: new Error("not enough allowance to spend") });
    expect(formatError(err)).toBe("Failed: not enough allowance to spend");
  });

  it("passes strings through", () => {
    expect(formatError("plain text")).toBe("plain text");
  });

  it("handles null and undefined", () => {
    expect(formatError(null)).toBe("Unknown error.");
    expect(formatError(undefined)).toBe("Unknown error.");
  });

  it("serializes bigints instead of throwing", () => {
    // JSON.stringify throws on bigint; a quote failure could easily carry one.
    expect(formatError({ amount: 10000000n })).toContain("10000000");
  });

  it("falls back to own property names when JSON yields nothing", () => {
    const weird = {};
    Object.defineProperty(weird, "hidden", { value: "surfaced", enumerable: false });
    expect(formatError(weird)).toContain("surfaced");
  });
});
