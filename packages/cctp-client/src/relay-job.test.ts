import { describe, expect, it, vi } from "vitest";
import type { IrisClient, IrisMessage } from "./iris.js";
import {
  type MintSubmitter,
  type RelayJobState,
  advanceRelayJob,
  createQueuedJob,
} from "./relay-job.js";

function irisReturning(messages: IrisMessage[]): IrisClient {
  return { getMessages: vi.fn(async () => messages) };
}

function irisThrowing(err: Error): IrisClient {
  return {
    getMessages: vi.fn(async () => {
      throw err;
    }),
  };
}

function mintSubmitter(signature = "sig123"): MintSubmitter {
  return { submitReceiveMessage: vi.fn(async () => ({ signature })) };
}

function failingMintSubmitter(err: Error): MintSubmitter {
  return {
    submitReceiveMessage: vi.fn(async () => {
      throw err;
    }),
  };
}

const BASE_JOB = createQueuedJob({ id: "job-1", sourceDomainId: 2, sourceTxHash: "0xabc" });

describe("advanceRelayJob", () => {
  it("stays waiting_attestation when Iris has no message yet", async () => {
    const result = await advanceRelayJob(BASE_JOB, {
      iris: irisReturning([]),
      mint: mintSubmitter(),
    });
    expect(result.status).toBe("waiting_attestation");
  });

  it("stays waiting_attestation when the message exists but isn't attested yet", async () => {
    const pending: IrisMessage = {
      message: "0xdead",
      attestation: null,
      eventNonce: "1",
      status: "pending_confirmations",
    };
    const result = await advanceRelayJob(BASE_JOB, {
      iris: irisReturning([pending]),
      mint: mintSubmitter(),
    });
    expect(result.status).toBe("waiting_attestation");
  });

  it("submits the mint once the message is attested, moving to submitted", async () => {
    const attested: IrisMessage = {
      message: "0xdead",
      attestation: "0xbeef",
      eventNonce: "1",
      status: "complete",
    };
    const mint = mintSubmitter("sig-abc");
    const result = await advanceRelayJob(BASE_JOB, { iris: irisReturning([attested]), mint });

    expect(result.status).toBe("submitted");
    expect(result.destTxSignature).toBe("sig-abc");
    expect(mint.submitReceiveMessage).toHaveBeenCalledWith("0xdead", "0xbeef");
  });

  it("moves to failed and records the error when mint submission throws", async () => {
    const attested: IrisMessage = {
      message: "0xdead",
      attestation: "0xbeef",
      eventNonce: "1",
      status: "complete",
    };
    const result = await advanceRelayJob(BASE_JOB, {
      iris: irisReturning([attested]),
      mint: failingMintSubmitter(new Error("insufficient SOL for fees")),
    });

    expect(result.status).toBe("failed");
    expect(result.attempts).toBe(1);
    expect(result.lastError).toMatch(/insufficient SOL/);
  });

  it("stays waiting_attestation (not failed) when Iris itself is transiently unavailable", async () => {
    const result = await advanceRelayJob(BASE_JOB, {
      iris: irisThrowing(new Error("ECONNRESET")),
      mint: mintSubmitter(),
    });
    // A down attestation service is retried, not treated as a hard failure of the relay job —
    // the burn already happened and is permanent; only the mint-submission step is fallible.
    expect(result.status).toBe("waiting_attestation");
    expect(result.lastError).toMatch(/ECONNRESET/);
  });

  it("is a no-op for a job that's already terminal", async () => {
    const submitted = { ...BASE_JOB, status: "submitted" as const };
    const result = await advanceRelayJob(submitted, {
      iris: irisReturning([]),
      mint: mintSubmitter(),
    });
    expect(result).toEqual(submitted);
  });
});

describe("retrying a failed job", () => {
  /**
   * A job that failed once must be able to try again. `decideNextStep` schedules `failed` for
   * another attempt, so if `advanceRelayJob` ignores that status the two requeue each other
   * forever — and since `attempts` only rises on a real submission failure, the attempt limit
   * never ends it either.
   *
   * This happened on mainnet: a burn whose mint failed on a transaction-size bug sat in `failed`,
   * was rescheduled every minute, and was never retried once the bug was fixed.
   */
  it("re-attempts the mint instead of returning untouched", async () => {
    let minted = 0;
    const failed: RelayJobState = {
      id: "job-1",
      sourceDomainId: 27,
      sourceTxHash: "aaa",
      status: "failed",
      attempts: 1,
      lastError: "Transaction too large: 1264 > 1232",
      createdAt: 1_000,
    };

    const next = await advanceRelayJob(failed, {
      iris: {
        getMessages: async () => [
          { status: "complete", message: "0xaa", attestation: "0xbb", eventNonce: "1" },
        ],
      } as unknown as IrisClient,
      mint: {
        submitReceiveMessage: async () => {
          minted++;
          return { signature: "sig-after-retry" };
        },
      },
    });

    expect(minted).toBe(1);
    expect(next.status).toBe("submitted");
    expect(next.destTxSignature).toBe("sig-after-retry");
  });

  it("leaves a submitted job alone", async () => {
    // Retrying a completed transfer would pay a fee to be rejected by `used_nonce`.
    const done: RelayJobState = {
      id: "job-2",
      sourceDomainId: 27,
      sourceTxHash: "bbb",
      status: "submitted",
      attempts: 0,
      createdAt: 1_000,
    };
    let minted = 0;
    const next = await advanceRelayJob(done, {
      iris: { getMessages: async () => [] } as unknown as IrisClient,
      mint: {
        submitReceiveMessage: async () => {
          minted++;
          return { signature: "should-not-happen" };
        },
      },
    });
    expect(minted).toBe(0);
    expect(next).toEqual(done);
  });
});
