/**
 * Is the relay able to do its job right now?
 *
 * # The failure this is for
 *
 * The hot wallet funds every mint, and each one costs 867,621 lamports of permanent rent that
 * nobody ever gets back. It drains by design. When it runs dry every transfer stalls at once —
 * and it stalls *silently*, because a job that cannot be paid for looks exactly like a job waiting
 * on Circle's attestation. Nothing errors, nothing retries visibly, users just watch a spinner.
 *
 * That is the single most likely way this product breaks in production, and the cheapest to catch.
 *
 * # The thresholds
 *
 * Measured, not guessed. One mint costs 867,621 lamports of `used_nonce` rent plus about 5,000 in
 * fees, and 2,039,280 more when the recipient has no USDC account — which is most first-time
 * users. So the worst-case cost of a single transfer is roughly 2.91M lamports.
 *
 * `critical` is two of those: below it, the very next transfer may fail. `warning` is ten, which
 * at any plausible early volume is a day or more of notice — enough to top up without hurrying.
 */

const WORST_CASE_MINT_LAMPORTS = 867_621 + 5_000 + 2_039_280;

export const RELAY_BALANCE_CRITICAL_LAMPORTS = WORST_CASE_MINT_LAMPORTS * 2;
export const RELAY_BALANCE_WARNING_LAMPORTS = WORST_CASE_MINT_LAMPORTS * 10;

export type RelayHealth = {
  ok: boolean;
  level: "ok" | "warning" | "critical";
  balanceLamports: number;
  /** Roughly how many more transfers the wallet can fund, worst case. Reported because
   *  "0.004 SOL" means nothing to a reader and "one more transfer" means everything. */
  mintsRemaining: number;
  message: string;
};

export function assessRelayBalance(balanceLamports: number): RelayHealth {
  const mintsRemaining = Math.floor(balanceLamports / WORST_CASE_MINT_LAMPORTS);
  const sol = (balanceLamports / 1_000_000_000).toFixed(4);

  if (balanceLamports < RELAY_BALANCE_CRITICAL_LAMPORTS) {
    return {
      ok: false,
      level: "critical",
      balanceLamports,
      mintsRemaining,
      message:
        `Relay hot wallet is at ${sol} SOL — about ${mintsRemaining} more transfer(s). ` +
        "Transfers will start stalling silently. Top it up now.",
    };
  }

  if (balanceLamports < RELAY_BALANCE_WARNING_LAMPORTS) {
    return {
      ok: true,
      level: "warning",
      balanceLamports,
      mintsRemaining,
      message: `Relay hot wallet is at ${sol} SOL — about ${mintsRemaining} more transfers.`,
    };
  }

  return {
    ok: true,
    level: "ok",
    balanceLamports,
    mintsRemaining,
    message: `Relay hot wallet is at ${sol} SOL — about ${mintsRemaining} more transfers.`,
  };
}
