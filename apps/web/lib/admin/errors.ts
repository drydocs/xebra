/**
 * Admin-facing wording for the wrapper's errors.
 *
 * `humanizeContractError` speaks to someone sending money ("this transfer…"); the admin needs the
 * governance codes explained, and for a few of them the honest answer is what to do next.
 * Numbers are the wrapper's `Error` enum, per contract, so this is only ever applied to calls made
 * to the wrapper itself.
 */
const ADMIN_ERRORS: Record<number, string> = {
  1: "This wallet is not allowed to do that. Connect the admin (or pauser) wallet.",
  2: "The wrapper is already paused.",
  3: "The wrapper is not paused.",
  20: "Fee is above the contract's 1.00% ceiling.",
  21: "Minimum fee is above the contract's 5 USDC ceiling.",
  22: "Minimum transfer is below the contract's 1 USDC floor.",
  23: "Maximum transfer is above the contract's hard ceiling.",
  24: "Circle fee allowance is above the contract's 0.50% ceiling.",
  25: "Minimum transfer must be below the maximum.",
  28: "There is nothing pending to commit.",
  29: "The 48 hour timelock has not elapsed yet. Try again once the countdown reaches zero.",
  30: "That is more than the wrapper has accrued in fees.",
  31: "That change is not a tightening, so it cannot be instant. Propose it instead (48 hour timelock).",
  32: "That destination is already configured exactly like this.",
  34: "Stellar is the source domain and cannot be a destination.",
  38: "Account fee is above the contract's 2 USDC ceiling.",
  42: "Forwarding configuration is invalid: caps are 0 to 2 USDC, forwarding needs a cap, and account creation needs forwarding, a Solana-style domain and its own cap.",
};

export function humanizeAdminError(raw: string): string {
  const m = raw.match(/Error\(Contract,\s*#(\d+)\)/);
  if (m) {
    const known = ADMIN_ERRORS[Number(m[1])];
    if (known) return known;
    return `The wrapper rejected the call (code ${m[1]}). Nothing changed.`;
  }
  return raw;
}
