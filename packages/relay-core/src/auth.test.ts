import { describe, expect, it } from "vitest";
import { authorizeBearer, isStellarTxHash } from "./auth.js";

const HASH = "92421fa248da1b1d4418784d5bd91adc4238dae72120e8f740920db7381905a7";

describe("isStellarTxHash", () => {
  it("accepts a real hash", () => {
    expect(isStellarTxHash(HASH)).toBe(true);
  });

  it("rejects the wrong shape", () => {
    // Upper case included: Horizon and the SDK both emit lower case, and accepting both would
    // let the same burn occupy two rows of a unique index that is byte-comparing text.
    for (const bad of ["", "not-hex", HASH.toUpperCase(), `${HASH}00`, HASH.slice(0, 63), 42, null]) {
      expect(isStellarTxHash(bad), String(bad)).toBe(false);
    }
  });
});

describe("authorizeBearer", () => {
  it("accepts the right token", () => {
    expect(authorizeBearer("Bearer secret", "secret")).toBe(true);
  });

  it("rejects a wrong token, a missing header and the wrong scheme", () => {
    expect(authorizeBearer("Bearer wrong", "secret")).toBe(false);
    expect(authorizeBearer(null, "secret")).toBe(false);
    expect(authorizeBearer(undefined, "secret")).toBe(false);
    expect(authorizeBearer("secret", "secret")).toBe(false);
    expect(authorizeBearer("Basic secret", "secret")).toBe(false);
  });

  it("rejects a token of a different length without throwing", () => {
    // timingSafeEqual throws on unequal-length buffers; hashing first is what avoids both the
    // throw and a length-based branch.
    expect(authorizeBearer("Bearer aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "secret")).toBe(false);
  });
});
