import { type Database, type claims, claims as claimsTable, intents } from "@xebra/db";
import { eq } from "drizzle-orm";

export interface ClaimLookup {
  intent: typeof intents.$inferSelect;
  claim: typeof claims.$inferSelect;
}

/**
 * The exact lookup this file's own module doc comment (see index.ts) has flagged as the missing
 * piece since apps/projector didn't populate `claims` — it does now (see
 * apps/projector/src/project-claim.ts), so this is real: resolving a challenge needs the claim's
 * asserted destination-chain proof (`destTxRef`, `deliveredAmount`) plus the intent's expected
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
