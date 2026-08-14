import { describe, expect, it } from "vitest";
import { type NearWindowCloseRow, countNearingClose } from "./near-window-close.js";

const NOW = 1_700_000_000_000;

function claimedSecondsAgo(seconds: number, challengeWindowSeconds: number): NearWindowCloseRow {
  return {
    intentHash: "0xabc",
    claimedAt: new Date(NOW - seconds * 1000),
    challengeWindowSeconds,
  };
}

describe("countNearingClose", () => {
  it("counts a claim whose window closes within the threshold", () => {
    // 25 of a 30-minute window elapsed -> 5 minutes remain, within a 10-minute threshold.
    const rows = [claimedSecondsAgo(25 * 60, 30 * 60)];
    expect(countNearingClose(rows, 10 * 60 * 1000, NOW)).toBe(1);
  });

  it("does not count a claim with plenty of time left", () => {
    // 5 of 30 minutes elapsed -> 25 minutes remain, outside a 10-minute threshold.
    const rows = [claimedSecondsAgo(5 * 60, 30 * 60)];
    expect(countNearingClose(rows, 10 * 60 * 1000, NOW)).toBe(0);
  });

  it("does not count a window that has already closed (finalize()'s job, not an alert)", () => {
    const rows = [claimedSecondsAgo(31 * 60, 30 * 60)];
    expect(countNearingClose(rows, 10 * 60 * 1000, NOW)).toBe(0);
  });

  it("counts multiple qualifying rows and ignores non-qualifying ones", () => {
    const rows = [
      claimedSecondsAgo(29 * 60, 30 * 60), // 1 min left -> counts
      claimedSecondsAgo(1 * 60, 30 * 60), // 29 min left -> doesn't count
      claimedSecondsAgo(22 * 60, 30 * 60), // 8 min left -> counts
    ];
    expect(countNearingClose(rows, 10 * 60 * 1000, NOW)).toBe(2);
  });
});
