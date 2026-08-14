import { describe, expect, it } from "vitest";
import { decideClaimValidity } from "./decide.js";

describe("decideClaimValidity", () => {
  it("resolves valid when the destination-chain verification succeeded", () => {
    expect(decideClaimValidity(true)).toBe(true);
  });

  it("resolves invalid when the destination-chain verification failed", () => {
    expect(decideClaimValidity(false)).toBe(false);
  });
});
