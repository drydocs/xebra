import { describe, expect, it } from "vitest";
import { NetworkConfigError, assertNetwork, loadNetworkConfig } from "./load.js";
import { MAINNET_PASSPHRASE, PRESETS } from "./networks.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";

function problemsOf(env: Record<string, string | undefined>): string[] {
  try {
    loadNetworkConfig(env);
    return [];
  } catch (e) {
    if (e instanceof NetworkConfigError) return e.problems;
    throw e;
  }
}

describe("loadNetworkConfig", () => {
  it("resolves the whole mainnet config from one variable", () => {
    const cfg = loadNetworkConfig({ NETWORK: "mainnet" });
    expect(cfg.network).toBe("mainnet");
    expect(cfg.stellar.networkPassphrase).toBe(MAINNET_PASSPHRASE);
    expect(cfg.stellar.tokenMessengerAddress).toBe(
      "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL",
    );
    expect(cfg.stellar.usdcAddress).toBe(
      "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75",
    );
    expect(cfg.solana.rpcUrl).toBe("https://api.mainnet-beta.solana.com");
    expect(cfg.solana.usdcAddress).toBe("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(cfg.arc.chainId).toBe(5042);
    expect(cfg.arc.usdcAddress).toBe("0x3600000000000000000000000000000000000000");
    expect(cfg.irisBaseUrl).toBe("https://iris-api.circle.com");
    expect(cfg.overrides).toEqual([]);
  });

  it("throws when NETWORK is missing rather than defaulting", () => {
    // No silent fallback. A wrong-but-working default is how a misconfigured build ships.
    expect(() => loadNetworkConfig({})).toThrow(NetworkConfigError);
    expect(problemsOf({})[0]).toContain("NETWORK is not set");
  });

  it("rejects testnet outright rather than half-configuring", () => {
    // Testnet support was removed. A stale NETWORK=testnet in an old shell or CI job must
    // fail loudly, not silently fall back to mainnet values under a testnet label.
    const problems = problemsOf({ NETWORK: "testnet" });
    expect(problems[0]).toContain("mainnet-only build");
  });

  it("rejects a testnet passphrase", () => {
    // The exact incoherence that used to start up cleanly.
    const problems = problemsOf({
      NETWORK: "mainnet",
      STELLAR_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
    });
    expect(problems.some((p) => p.includes("signs transactions against the wrong network"))).toBe(
      true,
    );
  });

  it("rejects any devnet/testnet/localhost endpoint", () => {
    expect(
      problemsOf({ NETWORK: "mainnet", SOLANA_RPC_URL: "https://api.devnet.solana.com" }).some(
        (p) => p.includes('contains "devnet"'),
      ),
    ).toBe(true);
    expect(
      problemsOf({ NETWORK: "mainnet", SOROBAN_RPC_URL: "http://localhost:8000" }).some((p) =>
        p.includes('contains "localhost"'),
      ),
    ).toBe(true);
  });

  it("rejects the Iris sandbox", () => {
    // A burn attested against the wrong Iris deployment stays pending forever.
    const problems = problemsOf({
      NETWORK: "mainnet",
      IRIS_BASE_URL: "https://iris-api-sandbox.circle.com",
    });
    expect(problems.some((p) => p.includes("IRIS_BASE_URL"))).toBe(true);
  });

  it("rejects an overridden Circle contract address", () => {
    const problems = problemsOf({
      NETWORK: "mainnet",
      STELLAR_USDC_ADDRESS: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
    });
    expect(problems.some((p) => p.includes("pinned"))).toBe(true);
  });

  it("reports every problem at once, not just the first", () => {
    const problems = problemsOf({
      NETWORK: "mainnet",
      STELLAR_NETWORK_PASSPHRASE: TESTNET_PASSPHRASE,
      SOLANA_RPC_URL: "http://localhost:8899",
      IRIS_BASE_URL: "https://iris-api-sandbox.circle.com",
    });
    expect(problems.length).toBeGreaterThanOrEqual(3);
  });

  it("allows a legitimate private RPC override and records it", () => {
    // A paid endpoint is the one override a production deploy actually needs.
    const cfg = loadNetworkConfig({
      NETWORK: "mainnet",
      SOROBAN_RPC_URL: "https://soroban.example-provider.com",
    });
    expect(cfg.stellar.sorobanRpcUrl).toBe("https://soroban.example-provider.com");
    expect(cfg.overrides).toContain("SOROBAN_RPC_URL");
  });

  it("rejects a tampered CCTP domain id", () => {
    expect(
      problemsOf({ NETWORK: "mainnet", STELLAR_CCTP_DOMAIN_ID: "5" }).some((p) =>
        p.includes("STELLAR_CCTP_DOMAIN_ID must be 27"),
      ),
    ).toBe(true);
  });

  it("pins Stellar to domain 27, Solana to domain 5 and Arc to domain 26", () => {
    const cfg = loadNetworkConfig({ NETWORK: "mainnet" });
    expect(cfg.stellar.cctpDomainId).toBe(27);
    expect(cfg.solana.cctpDomainId).toBe(5);
    expect(cfg.arc.cctpDomainId).toBe(26);
  });

  it("rejects an overridden Arc Circle contract or USDC address", () => {
    for (const name of [
      "ARC_TOKEN_MESSENGER_ADDRESS",
      "ARC_MESSAGE_TRANSMITTER_ADDRESS",
      "ARC_USDC_ADDRESS",
    ]) {
      const problems = problemsOf({
        NETWORK: "mainnet",
        [name]: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
      });
      expect(problems.some((p) => p.includes(name) && p.includes("pinned"))).toBe(true);
    }
  });

  it("rejects a tampered Arc domain id or chain id", () => {
    expect(
      problemsOf({ NETWORK: "mainnet", ARC_CCTP_DOMAIN_ID: "0" }).some((p) =>
        p.includes("ARC_CCTP_DOMAIN_ID must be 26"),
      ),
    ).toBe(true);
    // 5042002 is Arc's testnet chain id.
    expect(
      problemsOf({ NETWORK: "mainnet", ARC_CHAIN_ID: "5042002" }).some((p) =>
        p.includes("ARC_CHAIN_ID must be 5042"),
      ),
    ).toBe(true);
  });

  it("rejects an Arc testnet endpoint", () => {
    expect(
      problemsOf({ NETWORK: "mainnet", ARC_RPC_URL: "https://rpc.testnet.arc.io" }).some((p) =>
        p.includes('contains "testnet"'),
      ),
    ).toBe(true);
  });

  it("allows a private Arc RPC override and records it", () => {
    const cfg = loadNetworkConfig({
      NETWORK: "mainnet",
      ARC_RPC_URL: "https://rpc.quicknode.mainnet.arc.io",
    });
    expect(cfg.arc.rpcUrl).toBe("https://rpc.quicknode.mainnet.arc.io");
    expect(cfg.overrides).toContain("ARC_RPC_URL");
  });
});

describe("assertNetwork", () => {
  it("passes for mainnet", () => {
    expect(assertNetwork("mainnet", { NETWORK: "mainnet" }).network).toBe("mainnet");
  });

  it("there is only one preset", () => {
    expect(Object.keys(PRESETS)).toEqual(["mainnet"]);
  });
});
