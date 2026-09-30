import { STROOPS_PER_USDC } from "./policy";

/** Form <-> chain unit conversion. Fields are typed in USDC and percent; the chain holds stroops and bps. */

export function stroopsToField(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_USDC;
  const frac = (stroops % STROOPS_PER_USDC).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** null for anything that is not a plain non-negative decimal with at most 7 places. */
export function fieldToStroops(input: string): bigint | null {
  const t = input.trim();
  if (!/^\d+(\.\d{0,7})?$/.test(t)) return null;
  const [w = "0", f = ""] = t.split(".");
  return BigInt(w) * STROOPS_PER_USDC + BigInt(`${f}0000000`.slice(0, 7));
}

export function bpsToField(bps: number): string {
  return (bps / 100).toFixed(2);
}

/** "0.10" -> 10. Refuses anything finer than one basis point, since the chain cannot hold it. */
export function fieldToBps(input: string): number | null {
  const t = input.trim();
  if (!/^\d+(\.\d{0,2})?$/.test(t)) return null;
  const [w = "0", f = ""] = t.split(".");
  return Number(w) * 100 + Number(`${f}00`.slice(0, 2));
}

export function shortAddr(a: string): string {
  return a.length > 12 ? `${a.slice(0, 5)}…${a.slice(-5)}` : a;
}
