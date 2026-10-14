import { describe, expect, it } from "vitest";
import { feeDestination, routeDestination } from "./route-destination";

describe("routeDestination", () => {
  it("describes an EVM chain from the table", () => {
    const linea = routeDestination("linea");
    expect(linea).toMatchObject({ name: "Linea", cctpDomainId: 11 });
    expect(linea.evm?.chainId).toBe(59144);
    expect(linea.explorerTxUrl("0xab")).toBe("https://lineascan.build/tx/0xab");
  });

  it("describes Solana as the one destination with no EVM chain behind it", () => {
    const solana = routeDestination("solana");
    expect(solana).toMatchObject({ name: "Solana", cctpDomainId: 5, evm: null });
    expect(solana.explorerTxUrl("sig")).toBe("https://solscan.io/tx/sig");
  });
});

describe("feeDestination", () => {
  it("gives an EVM chain its own ceiling whatever the account question", () => {
    expect(feeDestination(routeDestination("ethereum"), true).maxForwardFeeUnits).toBe(5_000_000);
  });

  it("allows Solana more only when Circle is also opening the account", () => {
    const solana = routeDestination("solana");
    expect(feeDestination(solana, false).maxForwardFeeUnits).toBe(500_000);
    expect(feeDestination(solana, true).maxForwardFeeUnits).toBe(1_000_000);
  });
});
