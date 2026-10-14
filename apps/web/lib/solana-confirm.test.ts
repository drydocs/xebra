import type { Connection } from "@solana/web3.js";
import { describe, expect, it } from "vitest";
import { waitForSignature } from "./solana-confirm";

/** A Connection whose status polls return the given answers in order, then the last one forever. */
function polling(...answers: Array<unknown | Error>): Connection {
  let i = 0;
  return {
    getSignatureStatuses: async () => {
      const answer = answers[Math.min(i++, answers.length - 1)];
      if (answer instanceof Error) throw answer;
      return { context: { slot: 1 }, value: [answer] };
    },
  } as unknown as Connection;
}

const fast = { intervalMs: 1, timeoutMs: 200 };

describe("waitForSignature", () => {
  it("returns once the transaction is confirmed", async () => {
    const connection = polling(
      null,
      { confirmationStatus: "processed", err: null },
      {
        confirmationStatus: "confirmed",
        err: null,
      },
    );
    await expect(waitForSignature(connection, "sig", fast)).resolves.toBeUndefined();
  });

  it("throws for a transaction that landed and failed", async () => {
    // confirmTransaction resolved for this, and the page reported a mint that never happened.
    const connection = polling({
      confirmationStatus: "confirmed",
      err: { InstructionError: [0, 1] },
    });
    await expect(waitForSignature(connection, "sig", fast)).rejects.toThrow(/rejected/);
  });

  it("rides out a dropped poll", async () => {
    const connection = polling(new Error("fetch failed"), {
      confirmationStatus: "finalized",
      err: null,
    });
    await expect(waitForSignature(connection, "sig", fast)).resolves.toBeUndefined();
  });

  it("gives up with a message that says the transaction may still land", async () => {
    await expect(waitForSignature(polling(null), "sig", fast)).rejects.toThrow(/may still land/);
  });
});
