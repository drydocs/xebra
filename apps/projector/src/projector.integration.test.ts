import { type Database, chains, corridors, createDb, escrowEvents, intents } from "@xebra/db";
import type { ChainEvent } from "@xebra/event-bus";
import { ChainId } from "@xebra/intent-schema";
import { eq } from "drizzle-orm";
import pino from "pino";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { corridorId } from "./corridor-id.js";
import { projectEvent } from "./projector.js";

/** Runs against a real Postgres — see packages/db/README.md for the same pattern. Skipped
 *  automatically without TEST_DATABASE_URL. */
const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;
const logger = pino({ enabled: false });

const INTENT_HASH = `0x${"cc".repeat(32)}`;
const OPENED_EVENT: ChainEvent = {
  id: "2:tx1:0",
  chainId: ChainId.Stellar,
  intentHash: INTENT_HASH,
  eventType: "IntentOpened",
  txRef: "tx1",
  blockOrLedgerNumber: "100",
  observedAt: new Date().toISOString(),
  payload: {
    user: `0x${"11".repeat(32)}`,
    source_token: `0x${"0".repeat(64)}`,
    source_amount: "1000000000",
    dest_chain: ChainId.Solana,
    dest_asset: `0x${"22".repeat(32)}`,
    min_dest_amount: "900000000",
    dest_address: `0x${"33".repeat(32)}`,
    expiry: "2000000000",
    nonce: "1",
  },
};

describeIfDb("projectEvent (integration)", () => {
  let db: Database;

  beforeAll(async () => {
    db = createDb(connectionString as string);
    await db.insert(chains).values([
      { id: ChainId.Stellar, name: "Stellar", kind: "stellar" },
      { id: ChainId.Solana, name: "Solana", kind: "solana" },
    ]);
    await db.insert(corridors).values({
      id: corridorId(ChainId.Stellar, ChainId.Solana),
      sourceChainId: ChainId.Stellar,
      destChainId: ChainId.Solana,
      challengeWindowSeconds: 1800,
      active: true,
    });
  });

  afterAll(async () => {
    await db.delete(escrowEvents);
    await db.delete(intents);
    await db.delete(corridors);
    await db.delete(chains);
  });

  it("projects an IntentOpened event into a real intents row", async () => {
    await projectEvent(db, OPENED_EVENT, logger);

    const [row] = await db.select().from(intents).where(eq(intents.intentHash, INTENT_HASH));
    expect(row?.status).toBe("open");
    expect(row?.sourceAmount).toBe("1000000000");
    expect(row?.corridorId).toBe(corridorId(ChainId.Stellar, ChainId.Solana));
  });

  it("is idempotent: redelivering the same IntentOpened event doesn't error or duplicate", async () => {
    await projectEvent(db, OPENED_EVENT, logger);
    await projectEvent(db, OPENED_EVENT, logger);

    const rows = await db.select().from(intents).where(eq(intents.intentHash, INTENT_HASH));
    expect(rows).toHaveLength(1);
  });

  it("advances status on a later event and appends to escrow_events", async () => {
    const claimedEvent: ChainEvent = {
      ...OPENED_EVENT,
      id: "2:tx2:0",
      eventType: "IntentClaimed",
      txRef: "tx2",
    };

    await projectEvent(db, claimedEvent, logger);

    const [row] = await db.select().from(intents).where(eq(intents.intentHash, INTENT_HASH));
    expect(row?.status).toBe("claimed");

    const events = await db
      .select()
      .from(escrowEvents)
      .where(eq(escrowEvents.intentHash, INTENT_HASH));
    expect(events.map((e) => e.eventType).sort()).toEqual(["IntentClaimed", "IntentOpened"]);
  });
});
