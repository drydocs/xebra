import {
  bigint,
  boolean,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

/**
 * Postgres schema (docs/architecture.md §10): a queryable mirror of on-chain state. Chain state
 * stays canonical — every row here is a projection populated by apps/indexer-* watchers, never
 * the source of truth for fund custody. This is what lets apps/api answer status/verification
 * queries without the frontend hitting three different RPC/Horizon/Solana endpoints directly.
 */

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const chainKindEnum = pgEnum("chain_kind", ["evm", "stellar", "solana"]);
export const assetKindEnum = pgEnum("asset_kind", [
  "native",
  "evm_erc20",
  "stellar_classic_asset",
  "stellar_soroban_token",
  "spl_token",
]);
export const intentStatusEnum = pgEnum("intent_status", [
  "open",
  "claimed",
  "challenged",
  "finalized",
  "refunded",
]);
export const attestationStatusEnum = pgEnum("attestation_status", [
  "pending",
  "attested",
  "failed",
]);
export const relayJobStatusEnum = pgEnum("relay_job_status", [
  "queued",
  "waiting_attestation",
  "submitted",
  "confirmed",
  "failed",
]);
export const challengeStatusEnum = pgEnum("challenge_status", [
  "none",
  "challenged",
  "resolved_valid",
  "resolved_invalid",
]);

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

/** One row per chain xebra knows about. `id` matches `ChainId` from @xebra/intent-schema
 *  (1 = Arc, 2 = Stellar, 3 = Solana) so every FK below lines up with that enum directly. */
export const chains = pgTable("chains", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  kind: chainKindEnum("kind").notNull(),
  rpcConfigRef: text("rpc_config_ref"),
});

/** `assetId` is the canonical `AssetRef.assetId` hex32 from @xebra/intent-schema. `isNativeUsdc`
 *  is what packages/router-core's `StaticUsdcRegistry` is seeded from. */
export const assets = pgTable(
  "assets",
  {
    chainId: integer("chain_id")
      .notNull()
      .references(() => chains.id),
    assetKind: assetKindEnum("asset_kind").notNull(),
    assetId: text("asset_id").notNull(),
    symbol: text("symbol").notNull(),
    decimals: integer("decimals").notNull(),
    isNativeUsdc: boolean("is_native_usdc").notNull().default(false),
  },
  (table) => [primaryKey({ columns: [table.chainId, table.assetId] })],
);

/** One row per (sourceChain, destChain) pair. `escrowContractAddress` is null for a CCTP-only
 *  corridor with no intent/swap rail — packages/router-core's `resolveRoute` reads exactly this
 *  shape (see CorridorConfig there). */
export const corridors = pgTable("corridors", {
  id: text("id").primaryKey(), // e.g. "stellar->solana"
  sourceChainId: integer("source_chain_id")
    .notNull()
    .references(() => chains.id),
  destChainId: integer("dest_chain_id")
    .notNull()
    .references(() => chains.id),
  escrowContractAddress: text("escrow_contract_address"),
  challengeWindowSeconds: integer("challenge_window_seconds").notNull(),
  bondBps: integer("bond_bps").notNull().default(1000),
  active: boolean("active").notNull().default(true),
});

/** Mirrors @xebra/intent-schema's `IntentV2` — `user`/`destAddress` stored as the same
 *  `ChainAddress` JSON shape so the API can round-trip a row straight back into that type. */
export const intents = pgTable("intents", {
  intentHash: text("intent_hash").primaryKey(),
  corridorId: text("corridor_id")
    .notNull()
    .references(() => corridors.id),
  user: jsonb("user").notNull(), // ChainAddress
  sourceAssetId: text("source_asset_id").notNull(),
  sourceAmount: numeric("source_amount", { precision: 38, scale: 0 }).notNull(),
  destAssetId: text("dest_asset_id").notNull(),
  minDestAmount: numeric("min_dest_amount", { precision: 38, scale: 0 }).notNull(),
  destAddress: jsonb("dest_address").notNull(), // ChainAddress
  expiry: timestamp("expiry", { withTimezone: true }).notNull(),
  nonce: numeric("nonce", { precision: 38, scale: 0 }).notNull(),
  status: intentStatusEnum("status").notNull().default("open"),
  rawIntent: jsonb("raw_intent").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only mirror of on-chain events — Postgres is a projection, chain state stays
 *  canonical (see module doc comment). Never updated, only inserted. */
export const escrowEvents = pgTable("escrow_events", {
  id: text("id").primaryKey(), // e.g. `${chainId}:${txRef}:${logIndex}`
  intentHash: text("intent_hash")
    .notNull()
    .references(() => intents.intentHash),
  chainId: integer("chain_id")
    .notNull()
    .references(() => chains.id),
  eventType: text("event_type").notNull(), // "Opened" | "Claimed" | "Challenged" | "Resolved" | "Finalized" | "Refunded"
  txRef: text("tx_ref").notNull(),
  blockOrLedgerNumber: bigint("block_or_ledger_number", { mode: "bigint" }),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});

export const claims = pgTable("claims", {
  intentHash: text("intent_hash")
    .primaryKey()
    .references(() => intents.intentHash),
  solverAddress: text("solver_address").notNull(),
  destTxRef: text("dest_tx_ref").notNull(),
  deliveredAmount: numeric("delivered_amount", { precision: 38, scale: 0 }).notNull(),
  bondAmount: numeric("bond_amount", { precision: 38, scale: 0 }).notNull(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull(),
  challengeStatus: challengeStatusEnum("challenge_status").notNull().default("none"),
  challengerAddress: text("challenger_address"),
  challengedAt: timestamp("challenged_at", { withTimezone: true }),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
});

/** One row per CCTP-direct-rail transfer (docs/architecture.md §5) — distinct from `intents`,
 *  since a pure USDC->USDC move never touches an escrow contract at all. */
export const cctpTransfers = pgTable("cctp_transfers", {
  id: text("id").primaryKey(),
  sourceChainId: integer("source_chain_id")
    .notNull()
    .references(() => chains.id),
  destChainId: integer("dest_chain_id")
    .notNull()
    .references(() => chains.id),
  initiatorAddress: text("initiator_address").notNull(),
  burnTxRef: text("burn_tx_ref").notNull(),
  messageHash: text("message_hash").notNull(),
  amount: numeric("amount", { precision: 38, scale: 0 }).notNull(),
  attestationStatus: attestationStatusEnum("attestation_status").notNull().default("pending"),
  mintTxRef: text("mint_tx_ref"),
  // No forward FK to relay_jobs here on purpose: relay_jobs.cctp_transfer_id already provides
  // the relationship (a transfer has at most one active relay job), and a second FK pointing
  // the other way would make the two tables mutually referential — a real circular dependency,
  // not just a TypeScript inference annoyance. Look up a transfer's job with
  // `WHERE relay_jobs.cctp_transfer_id = cctp_transfers.id`.
});

/** Mirrors @xebra/cctp-client's `RelayJobState` (packages/cctp-client/src/relay-job.ts) — this
 *  is the `RelayJobStore` implementation apps/cctp-relay's `InMemoryRelayJobStore` placeholder
 *  is meant to be swapped out for. */
export const relayJobs = pgTable("relay_jobs", {
  id: text("id").primaryKey(),
  cctpTransferId: text("cctp_transfer_id")
    .notNull()
    .references(() => cctpTransfers.id),
  status: relayJobStatusEnum("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  solGasSpentLamports: numeric("sol_gas_spent_lamports", { precision: 38, scale: 0 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Feeds the low-inventory alerting in docs/architecture.md §11 (Grafana alert on a solver
 *  running low on a given chain/asset). Written periodically by apps/solver, not per-fill. */
export const solverInventorySnapshots = pgTable("solver_inventory_snapshots", {
  id: text("id").primaryKey(),
  chainId: integer("chain_id")
    .notNull()
    .references(() => chains.id),
  assetId: text("asset_id").notNull(),
  balance: numeric("balance", { precision: 38, scale: 0 }).notNull(),
  observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
});
