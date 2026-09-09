import { describe, expect, it } from "vitest";
import { humanizeContractError } from "./cctp-bridge";

const WRAPPER = "CCNWLGFMILJU476RZHDA2PSUH2WH3LIPERHS6BYPCRVDDYYNNUIKZMTJ";
const USDC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75";

/**
 * The real trace from a live mainnet attempt: an empty wallet, so USDC refused the fee transfer.
 * Both contracts report `Error(Contract, #10)` — the wrapper because the call it made failed, and
 * USDC because it was the one that refused. Newest-first, so the origin is last.
 */
const EMPTY_WALLET = `HostError: Error(Contract, #10)

Event log (newest first):
   0: [Diagnostic Event] contract:${WRAPPER}, topics:[error, Error(Contract, #10)], data:"escalating error to VM trap from failed host function call: call"
   1: [Diagnostic Event] contract:${WRAPPER}, topics:[error, Error(Contract, #10)], data:["contract call failed", transfer, [GBFI4X5E, ${WRAPPER}, 3000000]]
   2: [Failed Diagnostic Event (not emitted)] contract:${USDC}, topics:[error, Error(Contract, #10)], data:["resulting balance is not within the allowed range", 0, -3000000, 9223372036854775807]`;

const WRAPPER_REJECTED = `HostError: Error(Contract, #12)

Event log (newest first):
   0: [Diagnostic Event] contract:${WRAPPER}, topics:[error, Error(Contract, #12)], data:"escalating error to VM trap"`;

describe("humanizeContractError", () => {
  it("blames the wallet, not the bridge, when USDC refuses for balance", () => {
    // This exact trace was shown to a user as "The bridge rejected this transfer (code 10)".
    // The bridge rejected nothing — their wallet was empty. #10 happens to be
    // BadFinalityThreshold in our contract, which is why the wrong table produced a confident
    // and completely wrong answer.
    const msg = humanizeContractError(EMPTY_WALLET, WRAPPER);
    expect(msg).toMatch(/balance is too low/i);
    expect(msg).not.toMatch(/bridge rejected/i);
    expect(msg).not.toMatch(/delivery speed/i);
  });

  it("still maps our own codes when our contract threw", () => {
    expect(humanizeContractError(WRAPPER_REJECTED, WRAPPER)).toMatch(/below the minimum/i);
  });

  it("does not translate another contract's code with our table", () => {
    // Error numbers are per-contract. Circle's #12 is not our #12.
    const circle = "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL";
    const raw = `HostError: Error(Contract, #12)\n   0: [Diagnostic Event] contract:${circle}, topics:[error, Error(Contract, #12)], data:"failed"`;
    const msg = humanizeContractError(raw, WRAPPER);
    expect(msg).not.toMatch(/below the minimum/i);
    expect(msg).toMatch(/CAE2G5Z7/);
  });

  it("recognises a missing allowance", () => {
    const raw = `HostError: Error(Contract, #9)\n   0: contract:${USDC}, data:["not enough allowance to spend"]`;
    expect(humanizeContractError(raw, WRAPPER)).toMatch(/approval was not in place/i);
  });

  it("recognises a missing trustline", () => {
    expect(humanizeContractError("trustline entry is missing", WRAPPER)).toMatch(/trustline/i);
  });

  it("covers every code the contract can return on the bridge path", () => {
    // An unmapped code falls back to a number, which tells the user nothing. These are the
    // variants reachable from `bridge()`.
    for (const code of [2, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 36, 37]) {
      const raw = `HostError: Error(Contract, #${code})\n   0: [Diagnostic Event] contract:${WRAPPER}, topics:[error, Error(Contract, #${code})]`;
      expect(humanizeContractError(raw, WRAPPER), `code ${code}`).not.toMatch(/code \d+/);
    }
  });

  it("degrades to the raw error rather than inventing one", () => {
    expect(humanizeContractError("something entirely unexpected", WRAPPER)).toBe(
      "something entirely unexpected",
    );
  });

  it("works without a wrapper id, for callers that do not have one", () => {
    expect(humanizeContractError(EMPTY_WALLET)).toMatch(/balance is too low/i);
  });
});
