import type { claims } from "@xebra/db";
import type { ChainEvent } from "@xebra/event-bus";
import { ChainId } from "@xebra/intent-schema";

type NewClaimRow = typeof claims.$inferInsert;
type ChallengeUpdate = Partial<typeof claims.$inferInsert>;

/**
 * Populates the `claims` table this projector previously left untouched (see projector.ts's
 * module doc comment) — the piece apps/arbiter-service's own module doc comment names as the
 * exact thing blocking its claim-verification lookup. Same Arc-vs-Soroban split as
 * project-intent-opened.ts, for the same reason: genuinely different payload shapes (viem's
 * camelCase ABI arg names vs. the Soroban contract's snake_case struct field names — the latter
 * confirmed against real testnet events in scripts/e2e-demo, not guessed).
 */
export function projectIntentClaimed(event: ChainEvent): NewClaimRow | null {
  if (event.eventType !== "IntentClaimed" || !event.intentHash) return null;

  if (event.chainId === ChainId.ArcEvm) {
    return projectArcIntentClaimed(event);
  }
  if (event.chainId === ChainId.Stellar) {
    return projectSorobanIntentClaimed(event);
  }
  return null;
}

function projectArcIntentClaimed(event: ChainEvent): NewClaimRow | null {
  const p = event.payload;
  if (
    typeof p.solver !== "string" ||
    typeof p.stellarTxHash !== "string" ||
    typeof p.deliveredAmount !== "string" ||
    typeof p.solverBond !== "string"
  ) {
    return null;
  }

  return {
    intentHash: event.intentHash as string,
    solverAddress: p.solver,
    destTxRef: p.stellarTxHash,
    deliveredAmount: p.deliveredAmount,
    bondAmount: p.solverBond,
    claimedAt: new Date(event.observedAt),
  };
}

function projectSorobanIntentClaimed(event: ChainEvent): NewClaimRow | null {
  const p = event.payload;
  if (
    typeof p.solver !== "string" ||
    typeof p.dest_tx_ref !== "string" ||
    typeof p.delivered_amount !== "string" ||
    typeof p.solver_bond !== "string"
  ) {
    return null;
  }

  return {
    intentHash: event.intentHash as string,
    solverAddress: p.solver,
    destTxRef: p.dest_tx_ref,
    deliveredAmount: p.delivered_amount,
    bondAmount: p.solver_bond,
    claimedAt: new Date(event.observedAt),
  };
}

/** `IntentChallenged` payload's challenger field is named `challenger` on both chains (Arc's
 *  ABI arg and Soroban's struct field happen to agree here), so this one doesn't need a split —
 *  only the bond field's casing differs, and it isn't needed for this update. */
export function projectIntentChallenged(event: ChainEvent): ChallengeUpdate | null {
  if (event.eventType !== "IntentChallenged" || !event.intentHash) return null;
  const challenger = event.payload.challenger;
  if (typeof challenger !== "string") return null;

  return {
    challengeStatus: "challenged",
    challengerAddress: challenger,
    challengedAt: new Date(event.observedAt),
  };
}

export function projectIntentResolved(event: ChainEvent): ChallengeUpdate | null {
  if (event.eventType !== "IntentResolved" || !event.intentHash) return null;
  const claimValid = event.payload.claimValid ?? event.payload.claim_valid;
  if (typeof claimValid !== "boolean") return null;

  return {
    challengeStatus: claimValid ? "resolved_valid" : "resolved_invalid",
    resolvedAt: new Date(event.observedAt),
  };
}
