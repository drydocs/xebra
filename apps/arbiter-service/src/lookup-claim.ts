import { type Database, type claims, claims as claimsTable, intents } from "@xebra/db";
import { eq } from "drizzle-orm";

export interface ClaimLookup {
  intent: typeof intents.$inferSelect;
  claim: typeof claims.$inferSelect;
}

/**
 * Resolving a challenge needs the claim's asserted destination-chain proof (`destTxRef`,
 * `deliveredAmount`, written by apps/projector/src/project-claim.ts) plus the intent's expected
 * values (`destChain`, `destAssetId`, `minDestAmount`, `destAddress`), which live on two
 * different tables joined by `intentHash`.
 */
export async function lookupClaim(db: Database, intentHash: string): Promise<ClaimLookup | null> {
  const [intent] = await db.select().from(intents).where(eq(intents.intentHash, intentHash));
  if (!intent) return null;

  const [claim] = await db.select().from(claimsTable).where(eq(claimsTable.intentHash, intentHash));
  if (!claim) return null;

  return { intent, claim };
}
