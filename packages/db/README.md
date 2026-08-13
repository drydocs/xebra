# @xebra/db

Drizzle schema + Postgres client — the shared persistence layer for every backend service (see
docs/architecture.md §10).

## Develop

```bash
docker compose up -d postgres   # from repo root
cp .env.example .env             # set DATABASE_URL
pnpm generate                    # regenerate drizzle/ SQL after a schema.ts change
pnpm migrate                     # apply migrations
```

## Test

```bash
pnpm test                                            # unit-level; DB-backed tests auto-skip
TEST_DATABASE_URL=postgres://xebra:xebra@localhost:5432/xebra pnpm test:integration
```

`src/schema.integration.test.ts` round-trips a full corridor + intent through real foreign keys
(including verifying FK enforcement rejects a dangling reference) — this has been run against a
live Postgres, not just typechecked. All 9 tables and 11 foreign keys from docs/architecture.md
§10 generate and apply cleanly; `cctp_transfers` and `relay_jobs` reference each other
one-directionally only (`relay_jobs.cctp_transfer_id -> cctp_transfers.id`) — a second FK the
other way was removed deliberately to avoid a circular table dependency.
