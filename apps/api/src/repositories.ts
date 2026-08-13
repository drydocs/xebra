import {
  type Database,
  assets,
  cctpTransfers,
  chains,
  claims,
  corridors,
  intents,
} from "@xebra/db";
import { eq } from "drizzle-orm";

/**
 * Thin, real Drizzle data-access functions — the only place in this app that talks to Postgres
 * directly. Everything else (quote.ts, router.ts) takes plain data in and returns plain data
 * out, so it stays testable without a live database (see apps/cctp-relay's processJob for the
 * same separation pattern).
 */

export async function getActiveCorridors(db: Database) {
  return db.select().from(corridors).where(eq(corridors.active, true));
}

export async function getUsdcAssets(db: Database) {
  return db.select().from(assets).where(eq(assets.isNativeUsdc, true));
}

export async function getIntentByHash(db: Database, intentHash: string) {
  const [intent] = await db.select().from(intents).where(eq(intents.intentHash, intentHash));
  if (!intent) return undefined;

  const [claim] = await db.select().from(claims).where(eq(claims.intentHash, intentHash));
  return { intent, claim };
}

export async function getChains(db: Database) {
  return db.select().from(chains);
}

export async function getCctpTransferByBurnTx(db: Database, burnTxRef: string) {
  const [transfer] = await db
    .select()
    .from(cctpTransfers)
    .where(eq(cctpTransfers.burnTxRef, burnTxRef));
  return transfer;
}
