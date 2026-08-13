import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { type Database, createDb } from "./client.js";
import { assets, chains, corridors, intents } from "./schema.js";

/**
 * Runs against a real Postgres (see package README) — skipped automatically when
 * TEST_DATABASE_URL isn't set (e.g. plain `pnpm test` in CI without the docker-compose stack
 * up). `pnpm test:integration` in this package's script wires TEST_DATABASE_URL.
 */
const connectionString = process.env.TEST_DATABASE_URL;
const describeIfDb = connectionString ? describe : describe.skip;

describeIfDb("schema (integration)", () => {
  let db: Database;

  beforeAll(() => {
    db = createDb(connectionString as string);
  });

  afterAll(async () => {
    await db.delete(intents);
    await db.delete(corridors);
    await db.delete(assets);
    await db.delete(chains);
  });

  it("round-trips a full Stellar->Solana corridor + intent through real FKs", async () => {
    await db.insert(chains).values([
      { id: 2, name: "Stellar", kind: "stellar" },
      { id: 3, name: "Solana", kind: "solana" },
    ]);

    await db.insert(assets).values({
      chainId: 3,
      assetKind: "spl_token",
      assetId: `0x${"11".repeat(32)}`,
      symbol: "USDC",
      decimals: 6,
      isNativeUsdc: true,
    });

    await db.insert(corridors).values({
      id: "stellar->solana",
      sourceChainId: 2,
      destChainId: 3,
      escrowContractAddress: "CSOROBANESCROWPLACEHOLDER",
      challengeWindowSeconds: 1800,
      bondBps: 1000,
      active: true,
    });

    const intentHash = `0x${"aa".repeat(32)}`;
    await db.insert(intents).values({
      intentHash,
      corridorId: "stellar->solana",
      user: { chainId: 2, encoding: "stellar_ed25519_32", raw: `0x${"bb".repeat(32)}` },
      sourceAssetId: `0x${"0".repeat(64)}`,
      sourceAmount: "1000000000",
      destAssetId: `0x${"11".repeat(32)}`,
      minDestAmount: "900000000",
      destAddress: { chainId: 3, encoding: "solana_ed25519_32", raw: `0x${"cc".repeat(32)}` },
      expiry: new Date(Date.now() + 3_600_000),
      nonce: "1",
      status: "open",
      rawIntent: { placeholder: true },
    });

    const [row] = await db.select().from(intents).where(eq(intents.intentHash, intentHash));
    expect(row?.status).toBe("open");
    expect(row?.corridorId).toBe("stellar->solana");
  });

  it("rejects an intent referencing a nonexistent corridor (FK enforced)", async () => {
    await expect(
      db.insert(intents).values({
        intentHash: `0x${"ff".repeat(32)}`,
        corridorId: "does-not-exist",
        user: { chainId: 2, encoding: "stellar_ed25519_32", raw: `0x${"bb".repeat(32)}` },
        sourceAssetId: `0x${"0".repeat(64)}`,
        sourceAmount: "1",
        destAssetId: `0x${"11".repeat(32)}`,
        minDestAmount: "1",
        destAddress: { chainId: 3, encoding: "solana_ed25519_32", raw: `0x${"cc".repeat(32)}` },
        expiry: new Date(),
        nonce: "1",
        status: "open",
        rawIntent: {},
      }),
    ).rejects.toThrow();
  });
});
