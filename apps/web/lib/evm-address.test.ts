import { describe, expect, it } from "vitest";
import { ARC_UNSAFE_RECIPIENTS, checkArcAddress } from "./arc-address";
import { checkAddressOn, unsafeRecipientsFor } from "./evm-address";
import { EVM_CHAINS } from "./evm-chains";

// Foundry's first anvil account: public, with a documented EIP-55 form.
const WALLET = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

describe("checkAddressOn", () => {
  it("accepts a wallet on any chain and returns it left-padded to 32 bytes", () => {
    for (const chain of Object.values(EVM_CHAINS)) {
      const r = checkAddressOn(chain, WALLET);
      expect(r.ok, chain.id).toBe(true);
      expect([...(r.bytes as Uint8Array).slice(0, 12)]).toEqual(new Array(12).fill(0));
    }
  });

  it("names the chain the address is for, with the right article", () => {
    expect(checkAddressOn(EVM_CHAINS.base, "0x1234").error).toBe(
      "A Base address is 0x followed by 40 hex characters.",
    );
    expect(checkAddressOn(EVM_CHAINS.arbitrum, "0x1234").error).toBe(
      "An Arbitrum address is 0x followed by 40 hex characters.",
    );
    expect(
      checkAddressOn(EVM_CHAINS.polygon, "343zLQT4rL96rh6uNas2vm7gDSiv9CQ8dAFa8qvw2di5").error,
    ).toBe("That looks like a Solana address, not a Polygon one.");
  });

  it("refuses each chain's own USDC token and Circle's contracts on it", () => {
    for (const chain of Object.values(EVM_CHAINS)) {
      for (const [address, what] of Object.entries(unsafeRecipientsFor(chain))) {
        const r = checkAddressOn(chain, address);
        expect(r.ok, `${chain.id} ${address}`).toBe(false);
        expect(r.error).toContain(what);
      }
    }
  });

  it("does not refuse one chain's USDC token as a recipient on another", () => {
    // Base's USDC address is just an address on Arc. Refusing it there would be a rule with no
    // reason behind it.
    expect(checkAddressOn(EVM_CHAINS.arc, EVM_CHAINS.base.usdcAddress).ok).toBe(true);
  });

  it("refuses the zero address, burn addresses and a failed checksum everywhere", () => {
    const chain = EVM_CHAINS.arbitrum;
    expect(checkAddressOn(chain, `0x${"00".repeat(20)}`).error).toMatch(/zero address/);
    expect(checkAddressOn(chain, "0x000000000000000000000000000000000000dEaD").error).toMatch(
      /system or burn address/,
    );
    expect(checkAddressOn(chain, `${WALLET.slice(0, -1)}7`).error).toMatch(/checksum/);
  });
});

describe("checkArcAddress", () => {
  it("is the same check, with Arc's wording unchanged", () => {
    expect(checkArcAddress("0x1234").error).toBe(
      "An Arc address is 0x followed by 40 hex characters.",
    );
    expect(checkArcAddress("343zLQT4rL96rh6uNas2vm7gDSiv9CQ8dAFa8qvw2di5").error).toBe(
      "That looks like a Solana address, not an Arc one.",
    );
    expect(checkArcAddress(WALLET)).toEqual(checkAddressOn(EVM_CHAINS.arc, WALLET));
  });

  it("refuses exactly what the generated Arc list refuses", () => {
    expect(ARC_UNSAFE_RECIPIENTS).toEqual(unsafeRecipientsFor(EVM_CHAINS.arc));
  });
});
