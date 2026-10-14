/**
 * USDC amounts on EVM chains: 6 decimals, the same unit Circle's API quotes fees in.
 *
 * Deliberately not the helpers in `cctp-bridge.ts`. Those work in Stellar stroops (7 decimals), and
 * a number passed between the two is wrong by a factor of ten in a way no type would catch. The
 * names differ so the mistake is visible where it is made.
 */

export const UNITS_PER_USDC = 1_000_000n;

/** Parses USDC typed by a human ("12.5") into 6-decimal units, rejecting more than 6 decimals. */
export function parseUsdc6(input: string): bigint {
  const trimmed = input.trim();
  if (!/^\d*\.?\d*$/.test(trimmed) || trimmed === "" || trimmed === ".") {
    throw new Error("Enter an amount in USDC, for example 25.00");
  }
  const [whole = "0", fraction = ""] = trimmed.split(".");
  if (fraction.length > 6) {
    throw new Error("USDC has at most 6 decimal places here");
  }
  return BigInt(whole || "0") * UNITS_PER_USDC + BigInt(`${fraction}000000`.slice(0, 6));
}

/** Formats 6-decimal units for display. Trims trailing zeros but always keeps at least 2 decimals. */
export function formatUsdc6(units: bigint): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const whole = abs / UNITS_PER_USDC;
  const fraction = (abs % UNITS_PER_USDC).toString().padStart(6, "0").replace(/0+$/, "");
  const padded = fraction.length < 2 ? fraction.padEnd(2, "0") : fraction;
  return `${negative ? "-" : ""}${whole.toLocaleString("en-US")}.${padded}`;
}
