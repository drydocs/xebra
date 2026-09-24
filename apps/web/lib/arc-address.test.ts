import { PRESETS } from "@xebra/network-config";
import { getAddress } from "viem";
import { describe, expect, it } from "vitest";
import { ARC_UNSAFE_RECIPIENTS, checkArcAddress } from "./arc-address";

// Foundry's first anvil account: public, with a documented EIP-55 form.
const CHECKSUMMED = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("checkArcAddress", () => {
  it("returns the address left-padded to 32 bytes, the shape the wrapper requires", () => {
    const r = checkArcAddress(CHECKSUMMED);
    expect(r.ok).toBe(true);
    expect(r.bytes).toHaveLength(32);
    expect([...(r.bytes as Uint8Array).slice(0, 12)]).toEqual(new Array(12).fill(0));
    expect(Buffer.from((r.bytes as Uint8Array).slice(12)).toString("hex")).toBe(
      CHECKSUMMED.slice(2).toLowerCase(),
    );
  });

  it("is empty until the user types, without shouting an error at them", () => {
    expect(checkArcAddress("")).toEqual({ ok: false });
    expect(checkArcAddress("   ")).toEqual({ ok: false });
  });

  it("accepts all-lowercase and all-uppercase, which carry no checksum to fail", () => {
    expect(checkArcAddress(CHECKSUMMED.toLowerCase()).ok).toBe(true);
    expect(checkArcAddress(`0x${CHECKSUMMED.slice(2).toUpperCase()}`).ok).toBe(true);
  });

  it("refuses a mixed-case address whose checksum is wrong — that is a typo", () => {
    // Flip the case of one letter: still valid hex, no longer the checksummed form.
    const typo = CHECKSUMMED.replace(/[A-F]/, (c) => c.toLowerCase());
    expect(typo).not.toBe(CHECKSUMMED);
    const r = checkArcAddress(typo);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/checksum/i);
  });

  it("recognises a Solana address and says so", () => {
    const r = checkArcAddress("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Solana address/);
  });

  it("refuses anything that is not 0x plus 40 hex characters", () => {
    for (const bad of [
      "f39Fd6e51aad88F6F4ce6aB8827279cffFb92266", // no 0x, and not base58 either
      "0x1234",
      `${CHECKSUMMED}00`,
      `0x${"zz".repeat(20)}`,
      "vitalik.eth",
    ]) {
      const r = checkArcAddress(bad);
      expect(r.ok, bad).toBe(false);
      expect(r.error, bad).toBeTruthy();
    }
  });

  it("refuses the zero address, the precompile range and burn addresses", () => {
    expect(checkArcAddress(`0x${"00".repeat(20)}`).error).toMatch(/zero address/);
    expect(checkArcAddress("0x0000000000000000000000000000000000000001").error).toMatch(
      /system or burn/,
    );
    expect(checkArcAddress("0x000000000000000000000000000000000000dEaD").error).toMatch(
      /system or burn/,
    );
  });

  it("refuses the contracts USDC would be minted into", () => {
    for (const [addr, what] of Object.entries(ARC_UNSAFE_RECIPIENTS)) {
      const r = checkArcAddress(getAddress(addr));
      expect(r.ok, addr).toBe(false);
      expect(r.error, addr).toContain(what);
    }
  });

  it("trims whitespace pasted around the address", () => {
    expect(checkArcAddress(`  ${CHECKSUMMED}\n`).ok).toBe(true);
  });
});

describe("ARC_UNSAFE_RECIPIENTS", () => {
  it("agrees with the pinned network config, so a copy that drifted fails a test", () => {
    const { usdcAddress, tokenMessengerAddress, messageTransmitterAddress } = PRESETS.mainnet.arc;
    for (const pinned of [usdcAddress, tokenMessengerAddress, messageTransmitterAddress]) {
      expect(Object.keys(ARC_UNSAFE_RECIPIENTS)).toContain(pinned.toLowerCase());
    }
  });
});
