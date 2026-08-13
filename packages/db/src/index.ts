/**
 * @xebra/db — Drizzle schema + Postgres client, shared by every backend service
 * (apps/api, apps/solver, apps/cctp-relay, apps/indexer-*, apps/arbiter-service).
 * See docs/architecture.md §10.
 */

export * from "./schema.js";
export * from "./client.js";
