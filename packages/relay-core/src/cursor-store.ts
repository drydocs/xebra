import { type Database, watcherCursors } from "@xebra/db";
import { eq } from "drizzle-orm";

/**
 * Postgres-backed watcher cursor.
 *
 * An in-memory cursor is not merely lossy here, it is actively unsafe: on restart the watcher
 * falls back to `startLedger`, and once the RPC's ~24h event retention has moved past that
 * ledger the request returns the *newest* events instead of the missed ones. Every burn in the
 * gap is then never seen by anything, while the relay looks perfectly healthy.
 *
 * Writes go through an upsert on a fixed key, so there is exactly one row per watcher and no
 * migration needed when a second watcher is added — just a different id.
 */

const CURSOR_ID = "cctp-relay:stellar-burns";

export class PostgresCursorStore {
  constructor(
    private readonly db: Database,
    private readonly id: string = CURSOR_ID,
  ) {}

  async load(): Promise<string | undefined> {
    const rows = await this.db
      .select()
      .from(watcherCursors)
      .where(eq(watcherCursors.id, this.id))
      .limit(1);
    const cursor = rows[0]?.cursor;
    // An empty string is not a usable cursor — `getEvents` would reject it, and treating it as
    // present would suppress the `startLedger` bootstrap. Absent and empty mean the same thing.
    return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
  }

  async save(cursor: string): Promise<void> {
    await this.db
      .insert(watcherCursors)
      .values({ id: this.id, cursor, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: watcherCursors.id,
        set: { cursor, updatedAt: new Date() },
      });
  }
}
