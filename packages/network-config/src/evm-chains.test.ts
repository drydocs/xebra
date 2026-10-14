import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  EVM_ARC_PEERS,
  EVM_CHAINS,
  EVM_ROUTES,
  SOLANA_FROM_ARC,
  evmChainForDomain,
  isArcToSolana,
  isEvmRoute,
} from "./evm-chains.js";
import { PRESETS } from "./networks.js";

describe("EVM_CHAINS", () => {
  // Written out a second time on purpose. A changed value has to be changed here as well, by
  // someone who has just re-read it from the chain (`scripts/check-evm-cctp.sh`).
  it("pins every chain id, CCTP domain and USDC address", () => {
    const pinned = Object.values(EVM_CHAINS).map((c) => [
      c.id,
      c.chainId,
      c.cctpDomainId,
      c.usdcAddress,
    ]);
    expect(pinned).toEqual([
      ["avalanche", 43114, 1, "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E"],
      ["optimism", 10, 2, "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85"],
      ["arbitrum", 42161, 3, "0xaf88d065e77c8cC2239327C5EDb3A432268e5831"],
      ["base", 8453, 6, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"],
      ["polygon", 137, 7, "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359"],
      ["unichain", 130, 10, "0x078D782b760474a361dDA0AF3839290b0EF57AD6"],
      ["codex", 81224, 12, "0xd996633a415985DBd7D6D12f4A4343E31f5037cf"],
      ["sonic", 146, 13, "0x29219dd400f2Bf60E5a23d13Be72B486D4038894"],
      ["worldchain", 480, 14, "0x79A02482A880bCE3F13e09Da970dC34db4CD24d1"],
      ["monad", 143, 15, "0x754704Bc059F8C67012fEd69BC8A327a5aafb603"],
      ["sei", 1329, 16, "0xe15fC38F6D8c56aF07bbCBe3BAf5708A2Bf42392"],
      ["xdc", 50, 18, "0xfA2958CB79b0491CC627c1557F441eF849Ca8eb1"],
      ["hyperevm", 999, 19, "0xb88339CB7199b77E23DB6E890353E22632Ba630f"],
      ["ink", 57073, 21, "0x2D270e6886d130D724215A266106e6832161EAEd"],
      ["arc", 5042, 26, "0x3600000000000000000000000000000000000000"],
    ]);
  });

  it("uses Circle's one set of contract addresses on every chain", () => {
    for (const chain of Object.values(EVM_CHAINS)) {
      expect(chain.tokenMessengerAddress).toBe("0x28b5a0e9C621a5BadaA536219b3a228C8168cf5d");
      expect(chain.messageTransmitterAddress).toBe("0x81D40F21F12A8F0E3252Bccb954D722d4c464B64");
      expect(chain.tokenMinterAddress).toBe("0xfd78EE919681417d192449715b2594ab58f5D002");
    }
  });

  it("takes Arc from the preset rather than restating it", () => {
    const arc = PRESETS.mainnet.arc;
    expect(EVM_CHAINS.arc).toMatchObject({
      chainId: arc.chainId,
      cctpDomainId: arc.cctpDomainId,
      usdcAddress: arc.usdcAddress,
      tokenMessengerAddress: arc.tokenMessengerAddress,
      messageTransmitterAddress: arc.messageTransmitterAddress,
      rpcUrl: arc.rpcUrl,
      explorerUrl: arc.explorerUrl,
    });
  });

  it("gives no two chains the same chain id or domain", () => {
    const chains = Object.values(EVM_CHAINS);
    expect(new Set(chains.map((c) => c.chainId)).size).toBe(chains.length);
    expect(new Set(chains.map((c) => c.cctpDomainId)).size).toBe(chains.length);
  });

  it("offers Fast only where a burn is otherwise slow to finalise", () => {
    const fast = Object.values(EVM_CHAINS)
      .filter((c) => c.fast)
      .map((c) => c.id);
    // Where Iris prices the Fast row above zero for a burn made on the chain, 2026-10-14.
    expect(fast).toEqual([
      "optimism",
      "arbitrum",
      "base",
      "unichain",
      "codex",
      "worldchain",
      "ink",
    ]);
  });

  it("agrees with the table scripts/check-stellar-evm-cctp.sh checks against the chains", () => {
    // That script is bash and keeps its own copy. A chain added or changed here and not there
    // would be committed on the wrapper having never been read back from Circle's contracts.
    const script = readFileSync(
      new URL("../../../scripts/check-stellar-evm-cctp.sh", import.meta.url),
      "utf8",
    );
    const block = script.match(/^CHAINS="\n([\s\S]*?)^"/m)?.[1] ?? "";
    const rows = block
      .trim()
      .split("\n")
      .map((line) => {
        const [id, domain, usdc, , messenger, minter] = line.split("|");
        return [id, Number(domain), usdc, messenger, minter];
      });
    expect(rows).toEqual(
      Object.values(EVM_CHAINS).map((c) => [
        c.id,
        c.cctpDomainId,
        c.usdcAddress,
        c.tokenMessengerAddress,
        c.tokenMinterAddress,
      ]),
    );
  });

  it("points at no test network", () => {
    for (const chain of Object.values(EVM_CHAINS)) {
      expect(`${chain.rpcUrl} ${chain.explorerUrl}`).not.toMatch(/testnet|sepolia|fuji|amoy/i);
    }
  });
});

describe("EVM_ROUTES", () => {
  it("is each peer to Arc and Arc to each peer, and nothing else", () => {
    // Every EVM domain Circle forwards to from Arc (Iris, 2026-10-14) but Ethereum (0), Linea (11),
    // Plume (22) and EDGE (28), which are left out on purpose.
    expect(EVM_ARC_PEERS.map((id) => EVM_CHAINS[id].cctpDomainId)).toEqual([
      1, 2, 3, 6, 7, 10, 12, 13, 14, 15, 16, 18, 19, 21,
    ]);
    expect(EVM_ROUTES).toHaveLength(28);
    for (const left of [0, 11, 22, 28]) {
      expect(isEvmRoute(26, left)).toBe(false);
      expect(isEvmRoute(left, 26)).toBe(false);
    }
    for (const route of EVM_ROUTES) {
      expect([route.from, route.to].filter((id) => id === "arc")).toHaveLength(1);
    }
  });

  it("recognises a route by its two domains, in order", () => {
    expect(isEvmRoute(6, 26)).toBe(true);
    expect(isEvmRoute(26, 7)).toBe(true);
    // Not between two peers, not to itself, and not the wrapper's Stellar route.
    expect(isEvmRoute(6, 3)).toBe(false);
    expect(isEvmRoute(26, 26)).toBe(false);
    expect(isEvmRoute(27, 26)).toBe(false);
  });

  it("knows Arc to Solana as its own route, and Solana to Arc as none", () => {
    expect(isArcToSolana(26, 5)).toBe(true);
    expect(isArcToSolana(5, 26)).toBe(false);
    expect(isArcToSolana(6, 5)).toBe(false);
    expect(isEvmRoute(26, 5)).toBe(false);
    expect(SOLANA_FROM_ARC.maxForwardFeeNewAccountUnits).toBeGreaterThan(
      SOLANA_FROM_ARC.maxForwardFeeUnits,
    );
  });

  it("finds a chain by domain and admits when there is none", () => {
    expect(evmChainForDomain(6)?.id).toBe("base");
    expect(evmChainForDomain(5)).toBeNull();
    expect(evmChainForDomain(27)).toBeNull();
  });
});
