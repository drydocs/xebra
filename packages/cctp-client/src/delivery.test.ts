import { describe, expect, it } from "vitest";
import { readDelivery } from "./delivery.js";

const msg = (over: Record<string, unknown>) => ({
  messages: [
    { message: "0xab", eventNonce: "1", status: "complete", attestation: "0xcd", ...over },
  ],
});

describe("readDelivery", () => {
  it("is waiting when Iris has nothing, or nothing usable", () => {
    for (const body of [null, undefined, {}, { messages: [] }, { messages: [null] }, "x", []]) {
      expect(readDelivery(body).state, JSON.stringify(body)).toBe("waiting");
    }
  });

  it("is waiting while the attestation is still pending", () => {
    const d = readDelivery(msg({ status: "pending_confirmations", attestation: null }));
    expect(d.state).toBe("waiting");
  });

  it("is waiting when marked complete but the attestation is empty", () => {
    expect(readDelivery(msg({ attestation: null })).state).toBe("waiting");
    expect(readDelivery(msg({ attestation: "  " })).state).toBe("waiting");
  });

  it("is forwarding once attested and Circle has not finished the forward", () => {
    expect(readDelivery(msg({ forwardState: "PENDING" })).state).toBe("forwarding");
  });

  it("is delivered with the destination transaction when the forward completes", () => {
    const d = readDelivery(msg({ forwardState: "COMPLETE", forwardTxHash: "0xfeed" }));
    expect(d).toEqual({ state: "delivered", forwardTxHash: "0xfeed", reason: null });
  });

  it("is delivered even if the attestation field lags behind the forward", () => {
    const d = readDelivery(
      msg({ status: "pending_confirmations", attestation: null, forwardState: "COMPLETE" }),
    );
    expect(d.state).toBe("delivered");
  });

  it("is failed, with Circle's reason, when the forward fails", () => {
    const d = readDelivery(
      msg({
        forwardState: "FAILED",
        forwardErrorCode: "INSUFFICIENT_FEE",
        forwardErrorDetails: "fee too low",
      }),
    );
    expect(d).toEqual({
      state: "failed",
      forwardTxHash: null,
      reason: "INSUFFICIENT_FEE: fee too low",
    });
  });

  it("reports a failure before the attestation is final — that is when it is first visible", () => {
    const d = readDelivery(
      msg({ status: "pending_confirmations", attestation: null, forwardState: "FAILED" }),
    );
    expect(d.state).toBe("failed");
  });

  it("copes with a failure that carries no explanation", () => {
    expect(readDelivery(msg({ forwardState: "FAILED" })).reason).toBeNull();
  });

  it("is claimable when attested and the burn asked for no forwarding", () => {
    expect(readDelivery(msg({})).state).toBe("claimable");
  });

  it("does not care about the case of Circle's state names", () => {
    expect(readDelivery(msg({ forwardState: "complete", forwardTxHash: "0x1" })).state).toBe(
      "delivered",
    );
    expect(readDelivery(msg({ forwardState: "failed" })).state).toBe("failed");
  });

  it("reads only the first message", () => {
    const body = {
      messages: [
        msg({ forwardState: "PENDING" }).messages[0],
        msg({ forwardState: "FAILED" }).messages[0],
      ],
    };
    expect(readDelivery(body).state).toBe("forwarding");
  });
});
