import { checkEvmAddress } from "./evm-address";
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

/** Arc as a destination. The rules are the same on every EVM chain; see `lib/evm-address.ts`. */
export function checkArcAddress(input: string): AddressCheck {
  return checkEvmAddress(input, { chainName: "Arc", unsafe: ARC_UNSAFE_RECIPIENTS });
}
