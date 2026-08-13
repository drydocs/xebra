import { Keypair } from "@stellar/stellar-base";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import {
  chainAddressToEvmAddress,
  chainAddressToSolanaAddress,
  chainAddressToStellarAddress,
  evmAddressToChainAddress,
  solanaAddressToChainAddress,
  stellarAddressToChainAddress,
} from "./address.js";
import { AddrEncoding, ChainId } from "./types.js";

describe("evm address codec", () => {
  it("round-trips through ChainAddress", () => {
    // getAddress checksums it up front so the round-trip comparison isn't sensitive to case.
    const original = getAddress(`0x${"71".repeat(20)}`);
    const chainAddress = evmAddressToChainAddress(original);

    expect(chainAddress.chainId).toBe(ChainId.ArcEvm);
    expect(chainAddress.encoding).toBe(AddrEncoding.EvmAddress20);
    expect(chainAddress.raw).toHaveLength(66); // 0x + 64 hex chars

    expect(chainAddressToEvmAddress(chainAddress)).toBe(original);
  });

  it("rejects an invalid address", () => {
    expect(() => evmAddressToChainAddress("not-an-address")).toThrow();
  });
});

describe("stellar address codec", () => {
  it("round-trips a real ed25519 keypair through ChainAddress", () => {
    const kp = Keypair.random();
    const chainAddress = stellarAddressToChainAddress(kp.publicKey());

    expect(chainAddress.chainId).toBe(ChainId.Stellar);
    expect(chainAddress.encoding).toBe(AddrEncoding.StellarEd25519_32);

    expect(chainAddressToStellarAddress(chainAddress)).toBe(kp.publicKey());
  });
});

describe("solana address codec", () => {
  it("round-trips a base58 pubkey through ChainAddress", () => {
    // A well-known Solana devnet address (System Program) — stable, no RNG needed.
    const pubkey = "11111111111111111111111111111111";
    const chainAddress = solanaAddressToChainAddress(pubkey);

    expect(chainAddress.chainId).toBe(ChainId.Solana);
    expect(chainAddress.encoding).toBe(AddrEncoding.SolanaEd25519_32);

    expect(chainAddressToSolanaAddress(chainAddress)).toBe(pubkey);
  });

  it("rejects a pubkey that doesn't decode to 32 bytes", () => {
    expect(() => solanaAddressToChainAddress("2")).toThrow();
  });
});

describe("cross-chain raw slots are all 32 bytes", () => {
  it("normalizes a 20-byte EVM address and a 32-byte Solana/Stellar key to the same width", () => {
    const evm = evmAddressToChainAddress(`0x${"71".repeat(20)}`);
    const sol = solanaAddressToChainAddress("11111111111111111111111111111111");
    expect(evm.raw).toHaveLength(sol.raw.length);
  });
});
