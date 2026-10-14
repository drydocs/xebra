import { describe, expect, it } from "vitest";
import { feeDestination, routeDestination } from "./route-destination";

describe("routeDestination", () => {
  it("describes an EVM chain from the table", () => {
    const unichain = routeDestination("unichain");
    expect(unichain).toMatchObject({ name: "Unichain", cctpDomainId: 10 });
    expect(unichain.evm?.chainId).toBe(130);
    expect(unichain.explorerTxUrl("0xab")).toBe("https://uniscan.xyz/tx/0xab");
  });

  it("describes Solana as the one destination with no EVM chain behind it", () => {
    const solana = routeDestination("solana");
    expect(solana).toMatchObject({ name: "Solana", cctpDomainId: 5, evm: null });
    expect(solana.explorerTxUrl("sig")).toBe("https://solscan.io/tx/sig");
  });
});

describe("feeDestination", () => {
  it("gives an EVM chain its own ceiling whatever the account question", () => {
    expect(feeDestination(routeDestination("hyperevm"), true).maxForwardFeeUnits).toBe(500_000);
    expect(feeDestination(routeDestination("arc"), true).maxForwardFeeUnits).toBe(100_000);
  });

  it("allows Solana more only when Circle is also opening the account", () => {
    const solana = routeDestination("solana");
    expect(feeDestination(solana, false).maxForwardFeeUnits).toBe(500_000);
    expect(feeDestination(solana, true).maxForwardFeeUnits).toBe(1_000_000);
  });
});
