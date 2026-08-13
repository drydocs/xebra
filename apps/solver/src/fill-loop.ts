import type { IntentV2 } from "@xebra/intent-schema";
import type { Logger } from "pino";

/**
 * The solver's Watch->Fill->Claim pipeline (docs/architecture.md §7), generalized as
 * `FillAdapter`/`ClaimAdapter` interfaces so this orchestration logic is chain-agnostic and
 * fully unit-testable without a live Jupiter API or Soroban RPC connection — the same
 * separation pattern used throughout this codebase (apps/cctp-relay's processJob, the
 * indexers' poll functions). `apps/solver/src/adapters/*` supplies the concrete per-corridor
 * implementations; `index.ts` wires whichever adapter pair a given corridor's config selects.
 */

export interface FillQuote {
  canFill: boolean;
  /** Only meaningful when `canFill` is true. */
  deliveredAmount: bigint;
  reason?: string;
}

export interface FillResult {
  /** The destination-chain delivery transaction reference (e.g. a Solana tx signature). */
  destTxRef: string;
  deliveredAmount: bigint;
}

export interface ClaimResult {
  /** The source-chain claim transaction reference. */
  claimTxRef: string;
}

export interface FillAdapter {
  /** Checks profitability/inventory without submitting anything. */
  quote(intent: IntentV2): Promise<FillQuote>;
  /** Delivers `destAsset` to `destAddress`, binding the intent hash into the delivery tx
   *  (memo, or whatever the destination chain's proof convention is). */
  fill(intent: IntentV2, intentHash: string): Promise<FillResult>;
}

export interface ClaimAdapter {
  /** Posts the solver's bond and asserts delivery on the source-chain escrow. */
  claim(intentHash: string, fill: FillResult): Promise<ClaimResult>;
}

export type FillOutcome =
  | { status: "filled"; destTxRef: string; claimTxRef: string; deliveredAmount: bigint }
  | { status: "skipped"; reason: string }
  | { status: "failed"; stage: "fill" | "claim"; error: string };

export async function processOpenedIntent(
  intentHash: string,
  intent: IntentV2,
  deps: { fill: FillAdapter; claim: ClaimAdapter; logger: Logger },
): Promise<FillOutcome> {
  const quote = await deps.fill.quote(intent);
  if (!quote.canFill) {
    deps.logger.info({ intentHash, reason: quote.reason }, "solver: skipping unprofitable intent");
    return { status: "skipped", reason: quote.reason ?? "not profitable" };
  }

  let fillResult: FillResult;
  try {
    fillResult = await deps.fill.fill(intent, intentHash);
  } catch (err) {
    // Fill failed before any delivery happened — same as the spec's "thin DEX liquidity" failure
    // mode: fails atomically on the solver's side before any claim exists, no funds at risk.
    const error = describeError(err);
    deps.logger.error({ intentHash, error }, "solver: fill failed");
    return { status: "failed", stage: "fill", error };
  }

  deps.logger.info({ intentHash, destTxRef: fillResult.destTxRef }, "solver: delivered, claiming");

  try {
    const claimResult = await deps.claim.claim(intentHash, fillResult);
    return {
      status: "filled",
      destTxRef: fillResult.destTxRef,
      claimTxRef: claimResult.claimTxRef,
      deliveredAmount: fillResult.deliveredAmount,
    };
  } catch (err) {
    // Per the spec's failure-mode table: "solver delivers but never claims: user keeps the
    // delivery, solver eats the loss. Solver's problem by design." — this is a real loss for
    // the solver, but not a protocol-level failure; log loudly (lost margin) rather than crash.
    const error = describeError(err);
    deps.logger.error({ intentHash, error }, "solver: delivered but claim failed — margin lost");
    return { status: "failed", stage: "claim", error };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
