/**
 * A base-unit balance as text for the amount field: a plain decimal that `parseUsdc` and
 * `parseUsdc6` read back to exactly the same units.
 *
 * Not `formatUsdc`. That one is for display: it adds thousands separators, which the parsers
 * reject, and it pads to two decimals. This one keeps every digit the balance has, so the Max
 * button fills in precisely what the wallet holds and never a rounded-up figure that overdraws.
 */
export function unitsToInput(units: bigint, decimals: number): string {
  if (units <= 0n) return "0";
  const scale = 10n ** BigInt(decimals);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction === "" ? whole.toString() : `${whole}.${fraction}`;
}
