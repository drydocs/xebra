import type { ChainEvent } from "@xebra/event-bus";
import { ChainId } from "@xebra/intent-schema";
import { describe, expect, it } from "vitest";
import {
  projectIntentChallenged,
  projectIntentClaimed,
  projectIntentResolved,
} from "./project-claim.js";

const INTENT_HASH = "0x66ab5c8488e95dc9e3e70902548089ca9855bab628fdfa63fd5beabd16e8f3e9";

function arcClaimedEvent(overrides: Partial<ChainEvent> = {}): ChainEvent {
  return {
    id: "1:tx1:0",
    chainId: ChainId.ArcEvm,
    intentHash: INTENT_HASH,
    eventType: "IntentClaimed",
    txRef: "tx1",
    blockOrLedgerNumber: "100",
    observedAt: "2026-01-01T00:00:00.000Z",
    payload: {
      solver: `0x${"11".repeat(20)}`,
      stellarTxHash: `0x${"aa".repeat(32)}`,
      deliveredAmount: "1000000",
      solverBond: "50000000",
      challengeDeadline: "2000000000",
    },
    ...overrides,
  };
}

// Field shapes here match real events observed against a live testnet deployment in
// scripts/e2e-demo (see decode-soroban-events.ts's module doc comment) — snake_case struct
// field names, not a guess.
function sorobanClaimedEvent(overrides: Partial<ChainEvent> = {}): ChainEvent {
  return {
    id: "2:tx1:0",
    chainId: ChainId.Stellar,
    intentHash: INTENT_HASH,
    eventType: "IntentClaimed",
    txRef: "0f38da0c32d3ad3cde1dfa9d2a75b927d64c0a8228e1ba99723c529514f16840",
    blockOrLedgerNumber: "4139465",
    observedAt: "2026-08-14T14:46:31.000Z",
    payload: {
      solver: "GAUOB3MN5QAJV75G7ID253KYOWCRYB7U6BQ4WOVPXJAGVRNGRI7NJVTT",
      dest_tx_ref: "0x64656d6f",
      delivered_amount: "1000000",
      solver_bond: "250000000",
      challenge_deadline: "1786718851",
    },
    ...overrides,
  };
}

describe("projectIntentClaimed", () => {
  it("maps an Arc IntentClaimed event", () => {
    const row = projectIntentClaimed(arcClaimedEvent());
    expect(row).not.toBeNull();
    expect(row?.intentHash).toBe(INTENT_HASH);
    expect(row?.solverAddress).toBe(`0x${"11".repeat(20)}`);
    expect(row?.destTxRef).toBe(`0x${"aa".repeat(32)}`);
    expect(row?.deliveredAmount).toBe("1000000");
    expect(row?.bondAmount).toBe("50000000");
  });

  it("maps a Soroban IntentClaimed event using real testnet field names", () => {
    const row = projectIntentClaimed(sorobanClaimedEvent());
    expect(row).not.toBeNull();
    expect(row?.solverAddress).toBe("GAUOB3MN5QAJV75G7ID253KYOWCRYB7U6BQ4WOVPXJAGVRNGRI7NJVTT");
    expect(row?.destTxRef).toBe("0x64656d6f");
    expect(row?.bondAmount).toBe("250000000");
  });

  it("returns null for a non-IntentClaimed event", () => {
    expect(projectIntentClaimed(arcClaimedEvent({ eventType: "IntentOpened" }))).toBeNull();
  });

  it("returns null for a malformed payload", () => {
    expect(projectIntentClaimed(arcClaimedEvent({ payload: { solver: "0x1" } }))).toBeNull();
  });
});

describe("projectIntentChallenged", () => {
  it("maps a challenger address into a challengeStatus update", () => {
    const event: ChainEvent = {
      ...arcClaimedEvent(),
      eventType: "IntentChallenged",
      payload: { challenger: `0x${"22".repeat(20)}`, challengerBond: "50000000" },
    };
    const update = projectIntentChallenged(event);
    expect(update).toEqual({
      challengeStatus: "challenged",
      challengerAddress: `0x${"22".repeat(20)}`,
      challengedAt: new Date(event.observedAt),
    });
  });

  it("returns null for a non-IntentChallenged event", () => {
    expect(projectIntentChallenged(arcClaimedEvent())).toBeNull();
  });
});

describe("projectIntentResolved", () => {
  it("maps claimValid=true to resolved_valid", () => {
    const event: ChainEvent = {
      ...arcClaimedEvent(),
      eventType: "IntentResolved",
      payload: { claimValid: true },
    };
    expect(projectIntentResolved(event)?.challengeStatus).toBe("resolved_valid");
  });

  it("maps claimValid=false to resolved_invalid", () => {
    const event: ChainEvent = {
      ...arcClaimedEvent(),
      eventType: "IntentResolved",
      payload: { claimValid: false },
    };
    expect(projectIntentResolved(event)?.challengeStatus).toBe("resolved_invalid");
  });

  it("also accepts Soroban's snake_case claim_valid field", () => {
    const event: ChainEvent = {
      ...sorobanClaimedEvent(),
      eventType: "IntentResolved",
      payload: { claim_valid: false },
    };
    expect(projectIntentResolved(event)?.challengeStatus).toBe("resolved_invalid");
  });
});
