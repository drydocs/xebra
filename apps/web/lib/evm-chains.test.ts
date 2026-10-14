import {
  EVM_CHAINS as PINNED,
  EVM_ARC_PEERS as PINNED_PEERS,
  SOLANA_FROM_ARC as PINNED_SOLANA,
} from "@xebra/network-config";
import { describe, expect, it } from "vitest";
import {
  ARC_PEERS,
  EVM_ARC_PEERS,
  EVM_CHAINS,
  SOLANA_FROM_ARC,
  evmChainForChainId,
  evmChainForDomain,
  evmDestinationsFrom,
  evmSources,
  parseEnabledPeers,
} from "./evm-chains";

describe("EVM_CHAINS", () => {
  it("agrees with the pinned network config field for field, so a copy that drifted fails", () => {
    expect(EVM_CHAINS).toEqual(PINNED);
    expect(EVM_ARC_PEERS).toEqual(PINNED_PEERS);
    expect(SOLANA_FROM_ARC).toEqual(PINNED_SOLANA);
  });

  it("finds a chain by CCTP domain and by wallet chain id", () => {
    expect(evmChainForDomain(26)?.id).toBe("arc");
    expect(evmChainForDomain(27)).toBeNull();
    expect(evmChainForChainId(8453)?.id).toBe("base");
    expect(evmChainForChainId(11155111)).toBeNull();
  });
});

describe("which routes a build offers", () => {
  it("offers nothing until a peer is switched on", () => {
    expect(evmSources([])).toEqual([]);
    expect(evmDestinationsFrom("arc", [])).toEqual([]);
    expect(evmDestinationsFrom("base", [])).toEqual([]);
  });

  it("offers Solana only as somewhere Arc sends to", () => {
    expect(evmDestinationsFrom("arc", ["solana"])).toEqual(["solana"]);
    // Arc is a source once anything is on; Solana never is.
    expect(evmSources(["solana"])).toEqual(["arc"]);
    expect(evmDestinationsFrom("base", ["solana"])).toEqual([]);
  });

  it("offers an enabled peer both ways, and no other peer either way", () => {
    expect(evmSources(["base"])).toEqual(["base", "arc"]);
    expect(evmDestinationsFrom("base", ["base"])).toEqual(["arc"]);
    expect(evmDestinationsFrom("arc", ["base"])).toEqual(["base"]);
    expect(evmDestinationsFrom("ethereum", ["base"])).toEqual([]);
  });

  it("never offers a peer to a peer", () => {
    for (const peer of EVM_ARC_PEERS) {
      expect(evmDestinationsFrom(peer, EVM_ARC_PEERS)).toEqual(["arc"]);
    }
  });
});

describe("parseEnabledPeers", () => {
  it("is off when the variable is absent or empty", () => {
    expect(parseEnabledPeers(undefined)).toEqual([]);
    expect(parseEnabledPeers(null)).toEqual([]);
    expect(parseEnabledPeers("  ")).toEqual([]);
  });

  it("reads a list, in the table's order, forgiving spaces", () => {
    expect(parseEnabledPeers("base, arbitrum")).toEqual(["arbitrum", "base"]);
    expect(parseEnabledPeers("solana,linea")).toEqual(["linea", "solana"]);
    expect(parseEnabledPeers("all")).toEqual(ARC_PEERS);
    expect(ARC_PEERS).toHaveLength(19);
  });

  it("fails loudly on a name it does not know, and on Arc, which is not a peer", () => {
    expect(() => parseEnabledPeers("base,bsae")).toThrow('names "bsae"');
    expect(() => parseEnabledPeers("arc")).toThrow('names "arc"');
    expect(() => parseEnabledPeers("1")).toThrow('names "1"');
  });
});
