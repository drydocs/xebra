import { formatUsdc6 } from "./usdc6";

/**
 * Choosing the `maxFee` an EVM transfer signs, and refusing the ones it should not.
 *
 * On the Stellar route the wrapper contract bounds this number: a per-destination cap, and a tenth
 * of the burn. On the routes that call Circle directly nothing on chain does, and Circle keeps the
 * whole `maxFee` whatever delivery really cost (measured on Stellar; assumed here until a transfer
 * shows otherwise). So the same two bounds are applied in this file, before anyone is asked to
 * sign, and they are the only place they exist.
 *
 * The fee has two parts:
 *
 *   - **delivery**: Circle's `high` forwarding quote at 1.0x, the rule that has held on mainnet
 *     (`lib/forward-fee.ts`). Headroom above it is pure cost, because none of it comes back.
 *   - **speed**: Circle's Fast Transfer fee, a fraction of the amount, zero for Standard. Rounded
 *     up to a whole unit so the fee signed is never a unit short of the fee owed.
 *
 * All amounts are 6-decimal USDC units, the unit Circle quotes in.
 */

/** One speed of Circle's quote, as `/api/circle-health` returns it. */
export interface FeeTier {
  finalityThreshold: 1000 | 2000;
  /** Circle's `high` delivery fee, in 6-decimal units. */
  high: number;
  /** Circle's transfer fee, in parts per billion of the amount. */
  minimumFeePpb: number;
}

export interface FeeDestination {
  name: string;
  /** The most Circle may be paid to deliver into this chain, in 6-decimal units. */
  maxForwardFeeUnits: number;
}

export type FeePlan =
  | {
      ok: true;
      /** What the burn signs: everything Circle may keep. */
      maxFee: bigint;
      deliveryFee: bigint;
      speedFee: bigint;
      /** What the recipient is minted. */
      received: bigint;
    }
  | {
      ok: false;
      /**
       * `amount`: nothing to price yet. `minimum`: this amount is too small for the route, which
       * belongs under the amount field. `cap`: Circle's quote is one we will not sign, which is
       * about the route and not about anything the person typed.
       */
      kind: "amount" | "minimum" | "cap";
      reason: string;
    };

const PPB = 1_000_000_000n;
/** Fees may be at most this fraction of what is burned: one tenth, the wrapper's own rule. */
const FEE_FRACTION_DENOM = 10n;

/** Circle's Fast Transfer fee for `amount`, rounded up to a whole unit. */
export function speedFeeFor(amount: bigint, minimumFeePpb: number): bigint {
  if (minimumFeePpb <= 0) return 0n;
  return (amount * BigInt(minimumFeePpb) + PPB - 1n) / PPB;
}

function feesFor(amount: bigint, tier: FeeTier): { deliveryFee: bigint; speedFee: bigint } {
  return { deliveryFee: BigInt(tier.high), speedFee: speedFeeFor(amount, tier.minimumFeePpb) };
}

function withinTenth(amount: bigint, tier: FeeTier): boolean {
  const { deliveryFee, speedFee } = feesFor(amount, tier);
  const maxFee = deliveryFee + speedFee;
  return amount > maxFee && maxFee <= amount / FEE_FRACTION_DENOM;
}

/**
 * The smallest amount whose fees are at most a tenth of it. Found by search over the exact check,
 * as `minimumForwardedAmount` is, so the figure shown can never disagree with the rule applied.
 */
export function minimumEvmAmount(tier: FeeTier): bigint {
  let lo = 1n;
  let hi = 100_000_000_000n; // 100,000 USDC: far above any fee this bound could need
  if (!withinTenth(hi, tier)) return hi;
  while (lo < hi) {
    const mid = (lo + hi) / 2n;
    if (withinTenth(mid, tier)) hi = mid;
    else lo = mid + 1n;
  }
  return lo;
}

/** A figure to show a person: the minimum plus 5% for the fee moving, rounded up to the next cent. */
export function suggestedEvmMinimum(minimum: bigint): bigint {
  const withMargin = (minimum * 105n) / 100n;
  const cent = 10_000n;
  return ((withMargin + cent - 1n) / cent) * cent;
}

export function planEvmFee(input: {
  amount: bigint;
  tier: FeeTier;
  destination: FeeDestination;
}): FeePlan {
  const { amount, tier, destination } = input;
  if (amount <= 0n) return { ok: false, kind: "amount", reason: "Enter an amount to send." };
  if (!Number.isSafeInteger(tier.high) || tier.high <= 0) {
    return {
      ok: false,
      kind: "cap",
      reason: "Circle's delivery fee could not be read. Try again shortly.",
    };
  }

  const { deliveryFee, speedFee } = feesFor(amount, tier);
  const cap = BigInt(destination.maxForwardFeeUnits);
  if (deliveryFee > cap) {
    return {
      ok: false,
      kind: "cap",
      reason: `Circle's delivery fee (${formatUsdc6(deliveryFee)} USDC) is above the limit we allow for ${destination.name} right now (${formatUsdc6(cap)} USDC). Try again shortly.`,
    };
  }

  const maxFee = deliveryFee + speedFee;
  if (!withinTenth(amount, tier)) {
    const minimum = suggestedEvmMinimum(minimumEvmAmount(tier));
    return {
      ok: false,
      kind: "minimum",
      reason: `Fees would take more than a tenth of this transfer. Send at least ${formatUsdc6(minimum)} USDC to ${destination.name}.`,
    };
  }
  return { ok: true, maxFee, deliveryFee, speedFee, received: amount - maxFee };
}
