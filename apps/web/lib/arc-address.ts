import { isAddress } from "viem";
import type { AddressCheck } from "./solana-address";

/**
 * Validation for an Arc recipient.
 *
 * The same stakes as `solana-address.ts`: the mint goes to whatever this produces, a CCTP burn is
 * irreversible, and the contract can only check the *shape* (`check_mint_recipient` accepts any
 * non-zero, left-padded 20-byte value). It cannot tell a wallet from a mistake. That is this
 * file's job.
 *
 * # What it refuses beyond "is it hex"
 *
 *   - **A bad checksum.** A mixed-case address carries an EIP-55 checksum; one that fails it has a
 *     typo in it, and would otherwise be a perfectly valid address that nobody controls. An
 *     all-lowercase or all-uppercase address has no checksum to fail and is accepted, because
 *     refusing what most explorers and wallets copy would be its own failure.
 *   - **Addresses that can never hold a balance for a person:** the zero address, the low
 *     "precompile" range and burn addresses like `0x…dEaD`, and the contracts USDC itself would
 *     be minted *into* — the USDC token, and Circle's messenger, transmitter and minter. A mint
 *     to any of these is unrecoverable, and each is a plausible paste from an explorer page.
 *
 * It does not, and cannot, check that the recipient is a wallet rather than a contract that
 * refuses tokens, or that USDC's blocklist does not hold it. Both make the mint revert; the burn
 * is already done by then, which is what `/claim` exists for.
 */

/** Circle's contracts on Arc, read from the chain. Pinned in `packages/network-config`, and a
 *  test asserts these agree with it: a second copy is only safe if a test can tell it drifted.
 *  Kept out of the client bundle's import graph for the reason `lib/env.ts` explains. */
export const ARC_UNSAFE_RECIPIENTS: Record<string, string> = {
  "0x3600000000000000000000000000000000000000": "the USDC token contract itself",
  "0x28b5a0e9c621a5badaa536219b3a228c8168cf5d": "Circle's TokenMessenger contract",
  "0x81d40f21f12a8f0e3252bccb954d722d4c464b64": "Circle's MessageTransmitter contract",
  "0xfd78ee919681417d192449715b2594ab58f5d002": "Circle's TokenMinter contract",
};

const EVM_HEX = /^0x[0-9a-fA-F]{40}$/;
/** A Solana pubkey is 32–44 base58 characters. */
const LOOKS_LIKE_SOLANA = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function checkArcAddress(input: string): AddressCheck {
  const address = input.trim();
  if (address === "") return { ok: false };

  if (!address.startsWith("0x") && LOOKS_LIKE_SOLANA.test(address)) {
    return { ok: false, error: "That looks like a Solana address, not an Arc one." };
  }
  if (!EVM_HEX.test(address)) {
    return {
      ok: false,
      error: "An Arc address is 0x followed by 40 hex characters.",
    };
  }

  const body = address.slice(2);
  const mixedCase = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixedCase && !isAddress(address, { strict: true })) {
    return {
      ok: false,
      error: "The checksum does not match. There is a typo in this address — check it again.",
    };
  }

  const lower = address.toLowerCase();
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 20; i++) {
    bytes[12 + i] = Number.parseInt(lower.slice(2 + i * 2, 4 + i * 2), 16);
  }

  if (bytes.every((b) => b === 0)) {
    return { ok: false, error: "That is the zero address; nobody controls it." };
  }
  // Twelve padding bytes plus six more: an address below 2^112. Precompiles live here, and so
  // does 0x…dEaD.
  if (bytes.slice(0, 18).every((b) => b === 0)) {
    return {
      ok: false,
      error: "That is a system or burn address, not a wallet. USDC sent there is gone.",
    };
  }
  const unsafe = ARC_UNSAFE_RECIPIENTS[lower];
  if (unsafe) {
    return { ok: false, error: `That is ${unsafe}. USDC minted there could never be recovered.` };
  }

  return { ok: true, bytes };
}
