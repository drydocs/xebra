import { Address, scValToNative, type xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  buildInvocation,
  decodeDomain,
  decodeInstanceStorage,
  decodeParams,
  encodeDomain,
  encodeParams,
} from "./chain";
import { humanizeAdminError } from "./errors";

const A = "GBTVJ6JACFRBNI6BETAY4CWYWYNJHX43TGNEAVC3YQCSPPPY4R7H5TBN";
const P = "GBZWUXOTGHAAWMFNG262QPRIJJ77XI44VHZ4GAO4XYGPL43TDKAQVF42";

const params = {
  feeBps: 10,
  minFee: 3_000_000n,
  minTransfer: 10_000_000n,
  maxTransfer: 1_000_000_000n,
  maxCctpFeeBps: 20,
  accountFee: 0n,
};
const arc = {
  domain: 26,
  evmStyle: true,
  forward: true,
  maxForwardFee: 1_000_000n,
  accountCreation: false,
  maxForwardFeeNewAccount: 0n,
};

describe("struct encoding", () => {
  it("Params: symbol keys, exact integer widths, round-trips", () => {
    const sc = encodeParams(params);
    // A string-keyed map is what the SDK guesses without types; the contract cannot unpack it.
    const entries = sc.map() ?? [];
    expect(entries.map((e) => e.key().sym().toString())).toEqual([
      "account_fee",
      "fee_bps",
      "max_cctp_fee_bps",
      "max_transfer",
      "min_fee",
      "min_transfer",
    ]);
    const widths = Object.fromEntries(
      entries.map((e) => [e.key().sym().toString(), e.val().switch().name]),
    );
    expect(widths).toMatchObject({
      fee_bps: "scvU32",
      max_cctp_fee_bps: "scvU32",
      min_fee: "scvI128",
      max_transfer: "scvI128",
      account_fee: "scvI128",
    });
    expect(decodeParams(scValToNative(sc))).toEqual(params);
  });

  it("DomainCfg round-trips and keeps u32/i128/bool", () => {
    const sc = encodeDomain(arc);
    const widths = Object.fromEntries(
      (sc.map() ?? []).map((e) => [e.key().sym().toString(), e.val().switch().name]),
    );
    expect(widths).toMatchObject({
      domain: "scvU32",
      forward: "scvBool",
      max_forward_fee: "scvI128",
    });
    expect(decodeDomain(scValToNative(sc))).toEqual(arc);
  });
});

describe("buildInvocation", () => {
  it("tighten_domain passes six arguments in the contract's order", () => {
    const { method, args } = buildInvocation({ action: "tighten_domain", caller: P, cfg: arc });
    expect(method).toBe("tighten_domain");
    expect(args.map((a) => a.switch().name)).toEqual([
      "scvAddress",
      "scvU32",
      "scvBool",
      "scvI128",
      "scvBool",
      "scvI128",
    ]);
    expect(Address.fromScVal(args[0] as xdr.ScVal).toString()).toBe(P);
    expect(scValToNative(args[1] as xdr.ScVal)).toBe(26);
  });
  it("pause and cancel_pending pass the caller", () => {
    expect(buildInvocation({ action: "pause", caller: A }).args).toHaveLength(1);
    expect(buildInvocation({ action: "cancel_pending", caller: A }).args).toHaveLength(1);
  });
  it("commits and unpause take nothing", () => {
    for (const action of ["commit_params", "commit_domain", "unpause"] as const) {
      expect(buildInvocation({ action }).args).toHaveLength(0);
    }
  });
  it("withdraw_fees encodes i128", () => {
    const { args } = buildInvocation({ action: "withdraw_fees", amount: 2_000_000n });
    expect(args[0]?.switch().name).toBe("scvI128");
  });
});

describe("decodeInstanceStorage", () => {
  const baseParams = {
    fee_bps: 10,
    min_fee: 3_000_000n,
    min_transfer: 10_000_000n,
    max_transfer: 1_000_000_000n,
    max_cctp_fee_bps: 20,
    account_fee: 0n,
  };
  const base = [
    { key: "Admin", value: A },
    { key: "Pauser", value: P },
    { key: "FeeRecipient", value: A },
    {
      key: "Params",
      value: {
        fee_bps: 10,
        min_fee: 3_000_000n,
        min_transfer: 10_000_000n,
        max_transfer: 1_000_000_000n,
        max_cctp_fee_bps: 20,
        account_fee: 0n,
      },
    },
  ];
  const domain = {
    domain: 26,
    evm_style: true,
    forward: true,
    max_forward_fee: 1_000_000n,
    account_creation: false,
    max_forward_fee_new_account: 0n,
  };

  it("reads the live shape, with nothing pending", () => {
    const s = decodeInstanceStorage([
      ...base,
      { key: "Paused", value: false },
      { key: "AccruedFees", value: 0n },
      { key: "Domains", value: new Map([[26, domain]]) },
    ]);
    expect(s.admin).toBe(A);
    expect(s.paused).toBe(false);
    expect(s.domains).toEqual([arc]);
    expect(s.pendingParams).toBeNull();
    expect(s.pendingAdmin).toBeNull();
  });
  it("accepts a plain-object domain map and sorts by domain", () => {
    const s = decodeInstanceStorage([
      ...base,
      { key: "Domains", value: { 26: domain, 5: { ...domain, domain: 5 } } },
    ]);
    expect(s.domains.map((d) => d.domain)).toEqual([5, 26]);
  });
  it("decodes pending changes with their eta", () => {
    const s = decodeInstanceStorage([
      ...base,
      { key: "PendingParams", value: { params: { ...baseParams, fee_bps: 12 }, eta: 1234n } },
      { key: "PendingDomain", value: { cfg: domain, eta: 99n } },
      { key: "PendingAdmin", value: { addr: P, eta: 5n } },
    ]);
    expect(s.pendingParams?.value.feeBps).toBe(12);
    expect(s.pendingParams?.eta).toBe(1234n);
    expect(s.pendingDomain?.value.domain).toBe(26);
    expect(s.pendingAdmin).toEqual({ value: P, eta: 5n });
  });
  it("refuses storage that is not a v2 wrapper", () => {
    expect(() => decodeInstanceStorage([{ key: "Admin", value: A }])).toThrow(/Pauser/);
  });
});

describe("humanizeAdminError", () => {
  it("explains the governance codes", () => {
    expect(humanizeAdminError("HostError: Error(Contract, #29)")).toMatch(/timelock/i);
    expect(humanizeAdminError("HostError: Error(Contract, #31)")).toMatch(/Propose/);
    expect(humanizeAdminError("HostError: Error(Contract, #1)")).toMatch(/admin/);
  });
  it("does not invent a meaning for an unknown code", () => {
    expect(humanizeAdminError("Error(Contract, #999)")).toMatch(/code 999/);
  });
});
