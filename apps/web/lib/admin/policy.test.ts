import { describe, expect, it } from "vitest";
import {
  BOUNDS,
  type DomainCfg,
  type Params,
  canDo,
  classifyDomainChange,
  classifyParamsChange,
  formatDuration,
  rentLevel,
  roleOf,
  timelockState,
  validateDomainCfg,
  validateParams,
} from "./policy";

const U = 10_000_000n;

// What is live on mainnet today (deployments/mainnet.json, cctpWrapperV2).
const live: Params = {
  feeBps: 10,
  minFee: 3_000_000n,
  minTransfer: 10_000_000n,
  maxTransfer: 1_000_000_000n,
  maxCctpFeeBps: 20,
  accountFee: 0n,
};

const solana: DomainCfg = {
  domain: 5,
  evmStyle: false,
  forward: true,
  maxForwardFee: 2_500_000n,
  accountCreation: true,
  maxForwardFeeNewAccount: 4_500_000n,
};
const arc: DomainCfg = {
  domain: 26,
  evmStyle: true,
  forward: true,
  maxForwardFee: 1_000_000n,
  accountCreation: false,
  maxForwardFeeNewAccount: 0n,
};

describe("contract bounds are pinned", () => {
  // If the contract's ceilings change, this fails and the panel is updated on purpose.
  it("matches stellar-cctp-wrapper-v2", () => {
    expect(BOUNDS.maxFeeBps).toBe(100);
    expect(BOUNDS.maxMinFee).toBe(5n * U);
    expect(BOUNDS.minTransferFloor).toBe(1n * U);
    expect(BOUNDS.maxCctpFeeBps).toBe(50);
    expect(BOUNDS.maxAccountFee).toBe(2n * U);
    expect(BOUNDS.maxForwardFee).toBe(2n * U);
  });
});

describe("validateParams", () => {
  it("accepts what is live", () => {
    expect(validateParams(live).ok).toBe(true);
  });
  it.each([
    ["fee above 1%", { ...live, feeBps: 101 }],
    ["min fee above 5 USDC", { ...live, minFee: 5n * U + 1n }],
    ["min transfer under 1 USDC", { ...live, minTransfer: U - 1n }],
    ["min >= max", { ...live, minTransfer: live.maxTransfer }],
    ["circle allowance above 0.5%", { ...live, maxCctpFeeBps: 51 }],
    ["account fee above 2 USDC", { ...live, accountFee: 2n * U + 1n }],
    ["negative min fee", { ...live, minFee: -1n }],
    ["fractional bps", { ...live, feeBps: 10.5 }],
  ])("rejects %s", (_name, p) => {
    expect(validateParams(p as Params).ok).toBe(false);
  });
});

describe("classifyParamsChange", () => {
  it("no change is a noop", () => {
    expect(classifyParamsChange(live, { ...live })).toBe("noop");
  });
  it("lowering fees and raising the minimum is instant", () => {
    expect(
      classifyParamsChange(live, { ...live, feeBps: 5, minFee: 2_000_000n, minTransfer: 20n * U }),
    ).toBe("tighten");
  });
  it("lowering the ceiling is instant", () => {
    expect(classifyParamsChange(live, { ...live, maxTransfer: 50n * U })).toBe("tighten");
  });
  it("raising the fee waits 48h", () => {
    expect(classifyParamsChange(live, { ...live, feeBps: 11 })).toBe("propose");
  });
  it("raising the ceiling waits 48h", () => {
    expect(classifyParamsChange(live, { ...live, maxTransfer: live.maxTransfer + 1n })).toBe(
      "propose",
    );
  });
  it("lowering the minimum waits 48h", () => {
    expect(classifyParamsChange(live, { ...live, minTransfer: live.minTransfer - 1n })).toBe(
      "propose",
    );
  });
  it("a mix of tightening and loosening is a proposal", () => {
    expect(classifyParamsChange(live, { ...live, feeBps: 5, minFee: live.minFee + 1n })).toBe(
      "propose",
    );
  });
});

describe("validateDomainCfg", () => {
  it("accepts the live domains", () => {
    expect(validateDomainCfg(solana).ok).toBe(true);
    expect(validateDomainCfg(arc).ok).toBe(true);
  });
  it("refuses Stellar as a destination", () => {
    expect(validateDomainCfg({ ...arc, domain: 27 }).ok).toBe(false);
  });
  it("forwarding needs a cap", () => {
    expect(validateDomainCfg({ ...arc, maxForwardFee: 0n }).ok).toBe(false);
  });
  it("cap is bounded at 2 USDC", () => {
    expect(validateDomainCfg({ ...arc, maxForwardFee: 2n * U + 1n }).ok).toBe(false);
  });
  it("account creation needs forwarding, a non-EVM domain and its own cap", () => {
    expect(validateDomainCfg({ ...solana, forward: false }).ok).toBe(false);
    expect(
      validateDomainCfg({ ...arc, accountCreation: true, maxForwardFeeNewAccount: 1n }).ok,
    ).toBe(false);
    expect(validateDomainCfg({ ...solana, maxForwardFeeNewAccount: 0n }).ok).toBe(false);
  });
  it("a new-account cap without creation is refused", () => {
    expect(validateDomainCfg({ ...solana, accountCreation: false }).ok).toBe(false);
  });
});

describe("classifyDomainChange", () => {
  it("adding a domain is always a proposal", () => {
    expect(classifyDomainChange(null, { ...arc, domain: 30 })).toBe("propose");
  });
  it("same config is a noop", () => {
    expect(classifyDomainChange(arc, { ...arc })).toBe("noop");
  });
  it("lowering a cap is instant", () => {
    expect(classifyDomainChange(arc, { ...arc, maxForwardFee: 500_000n })).toBe("tighten");
  });
  it("raising a cap waits 48h", () => {
    expect(classifyDomainChange(arc, { ...arc, maxForwardFee: 1_500_000n })).toBe("propose");
  });
  it("turning forwarding on waits 48h", () => {
    expect(classifyDomainChange({ ...arc, forward: false }, arc)).toBe("propose");
  });
  it("forwarding off is instant even if the other fields are left as they were", () => {
    // The contract normalises creation off and its cap to zero.
    const off = classifyDomainChange(solana, { ...solana, forward: false });
    expect(off).toBe("tighten");
  });
  it("turning account creation on waits 48h", () => {
    expect(
      classifyDomainChange(
        { ...solana, accountCreation: false, maxForwardFeeNewAccount: 0n },
        solana,
      ),
    ).toBe("propose");
  });
  it("changing address style is never instant", () => {
    expect(classifyDomainChange(arc, { ...arc, evmStyle: false })).toBe("propose");
  });
});

describe("roles", () => {
  const A = "GADMIN";
  const P = "GPAUSER";
  it("identifies the signer", () => {
    expect(roleOf(A, A, P)).toBe("admin");
    expect(roleOf(P, A, P)).toBe("pauser");
    expect(roleOf("GOTHER", A, P)).toBe("viewer");
    expect(roleOf(null, A, P)).toBe("viewer");
  });
  it("pauser can only reduce exposure", () => {
    expect(canDo("pauser", "pause")).toBe(true);
    expect(canDo("pauser", "tighten_domain")).toBe(true);
    expect(canDo("pauser", "cancel_pending")).toBe(true);
    expect(canDo("pauser", "propose_params")).toBe(false);
    expect(canDo("pauser", "unpause")).toBe(false);
    expect(canDo("pauser", "withdraw_fees")).toBe(false);
    expect(canDo("pauser", "tighten_params")).toBe(false);
  });
  it("viewer can do nothing, admin everything", () => {
    expect(canDo("viewer", "pause")).toBe(false);
    expect(canDo("admin", "commit_domain")).toBe(true);
  });
});

describe("time helpers", () => {
  it("timelock", () => {
    expect(timelockState(1000n, 900)).toEqual({ ready: false, secondsLeft: 100 });
    expect(timelockState(1000n, 1000)).toEqual({ ready: true, secondsLeft: 0 });
    expect(timelockState(1000n, 1500).ready).toBe(true);
  });
  it("duration", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(45)).toBe("45s");
    expect(formatDuration(125)).toBe("2m 5s");
    expect(formatDuration(3 * 3600 + 12 * 60)).toBe("3h 12m");
    expect(formatDuration(86_400 + 4 * 3600)).toBe("1d 4h");
  });
  it("rent levels", () => {
    expect(rentLevel(90 * 86_400)).toBe("ok");
    expect(rentLevel(30 * 86_400)).toBe("soon");
    expect(rentLevel(10 * 86_400)).toBe("urgent");
  });
});
