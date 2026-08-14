import { type Database, claims, corridors, intents } from "@xebra/db";
import { and, eq } from "drizzle-orm";

/**
 * Backs docs/architecture.md §11's "unclaimed-but-delivered intents nearing challenge-window
 * close" alert: a claim nobody has challenged yet, whose challenge window is about to close (so
 * `finalize()` is imminent and there's no more time for a challenger to act).
 */
export interface NearWindowCloseRow {
  intentHash: string;
  claimedAt: Date;
  challengeWindowSeconds: number;
}

/** Pure so it's unit-testable without a live Postgres — see near-window-close.test.ts. */
export function countNearingClose(
  rows: NearWindowCloseRow[],
  thresholdMs: number,
  now: number,
): number {
  return rows.filter((row) => {
    const closesAt = row.claimedAt.getTime() + row.challengeWindowSeconds * 1000;
    const remaining = closesAt - now;
    return remaining > 0 && remaining <= thresholdMs;
  }).length;
}

export async function fetchUnchallengedClaimedRows(db: Database): Promise<NearWindowCloseRow[]> {
  return db
    .select({
      intentHash: claims.intentHash,
      claimedAt: claims.claimedAt,
      challengeWindowSeconds: corridors.challengeWindowSeconds,
    })
    .from(claims)
    .innerJoin(intents, eq(intents.intentHash, claims.intentHash))
    .innerJoin(corridors, eq(corridors.id, intents.corridorId))
    .where(and(eq(claims.challengeStatus, "none"), eq(intents.status, "claimed")));
}
