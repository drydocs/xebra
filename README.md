# Xebra

Intent-based swap-capable cross-chain bridge.

- **Corridor 1 (v1, spec frozen):** Arc → Stellar. See [`xebra-spec_051150 (1).md`](<./xebra-spec_051150 (1).md>).
- **Corridor 2 (this build):** Stellar → Solana, with Stellar acting as the settlement hub. Two rails: a direct CCTP USDC leg and the intent/escrow/solver swap leg from corridor 1, auto-routed. See [`docs/architecture.md`](./docs/architecture.md) for the full design.

## Repo layout

```
apps/
  web/                  # Next.js frontend (all corridors, both rails)
  api/                  # tRPC + REST facade over Postgres — the only thing the frontend talks to
  solver/                # multi-chain fill bot (chain-adapter composed per corridor)
  cctp-relay/            # CCTP mint-relay service (gas-sponsors the Solana receiveMessage call)
  arbiter-service/       # KMS-backed resolve() submitter for the v1 admin-arbiter role
  indexer-arc/            # Arc (EVM) chain watcher
  indexer-stellar/        # Stellar (classic + Soroban) chain watcher
  indexer-solana/         # Solana chain watcher
packages/
  intent-schema/          # IntentV2 schema, arc-v1 adapter, canonical hashing
  router-core/            # CCTP-direct vs intent/swap routing rule (shared frontend+backend)
  chain-adapters/         # Watch/Fill/Claim adapters per chain, composed by apps/solver
  cctp-client/            # shared CCTP burn/attest/mint client (used by solver + relay)
  arbiter-signer/         # KMS-backed EVM (secp256k1) + Stellar (Ed25519) signer adapters
  db/                     # Drizzle schema + migrations, shared Postgres access
contracts/
  arc-evm/                 # XebraEscrow.sol — Arc-side escrow (v1 spec, frozen)
  stellar-soroban/         # XebraEscrow (Soroban) — Stellar-as-source escrow (new)
infra/
  terraform/               # IaC for staging/prod (ECS Fargate, RDS, ElastiCache, Redpanda, KMS)
  docker-compose.yml        # local dev: anvil, Stellar quickstart, solana-test-validator, Postgres, Redis, Redpanda
docs/
  architecture.md          # full design doc (source of truth alongside the spec)
```

## Tech stack

| Layer | Choice | Why |
|---|---|---|
| Monorepo | pnpm workspaces + Turborepo | task-graph caching across many small TS services + non-JS contract packages |
| Contracts (Arc) | Solidity + Foundry | unchanged from v1 spec |
| Contracts (Stellar) | Rust + `soroban-sdk` | native `require_auth`, no bespoke signature scheme needed |
| Solana delivery | SPL Memo + SPL Transfer (no bespoke program) | falsifiability comes from the public tx, not a program attesting to it |
| Backend language | TypeScript (Node 22) | one language across api/solver/relay/indexers/frontend |
| API | tRPC (+ thin REST/OpenAPI facade) | end-to-end types frontend↔backend, REST facade for non-TS consumers |
| DB / ORM | Postgres + Drizzle | queryable mirror of on-chain state; inspectable SQL, no query-engine binary |
| Event backbone | Redpanda (Kafka API) | durable, replayable multi-consumer event stream |
| Job queue | BullMQ + Redis | idempotent retryable actions (CCTP mint submission, claim/finalize, resolve) |
| Frontend | Next.js (App Router) | corridor selector, status dashboard, shareable `/intent/[hash]` verification pages |
| Arbiter custody | AWS KMS (Ed25519 + secp256k1) | no raw hot key |
| Compute | ECS Fargate | small, stateless service count — no K8s scheduling need |
| IaC | Terraform | |
| Observability | pino + OpenTelemetry → Grafana Cloud | |
| Lint/format | Biome | single fast binary, replaces ESLint+Prettier |

## Local development

```bash
pnpm install
docker compose up -d          # anvil, stellar quickstart, solana-test-validator, postgres, redis, redpanda
pnpm db:migrate
pnpm dev
```

## Status

See `docs/architecture.md` for the phased delivery plan. Nothing here is deployed to a public network yet. Progress against that plan:

**Built and verified** (compiled/tested; several pieces run live — see each package's own README for exactly what):
- `contracts/arc-evm` — full XebraEscrow.sol, 17 Foundry tests incl. both dispute outcomes.
- `contracts/stellar-soroban` — full Stellar-source XebraEscrow, 14 tests, release wasm builds.
- `packages/intent-schema`, `router-core`, `chain-adapters`, `cctp-client`, `event-bus`, `db` — all with real logic and tests; `chain-adapters`' Arc log decoding is proven against a real anvil-deployed contract (`arc/decode.live.test.ts`); `db`'s schema has been migrated onto and queried against a live Postgres.
- `apps/api` — tRPC + Postgres, run live end-to-end against a seeded database.
- `apps/cctp-relay`, `apps/indexer-arc`, `apps/indexer-stellar`, `apps/indexer-solana`, `apps/solver` — real orchestration logic (each unit-tested with injected/mocked chain clients), thin live wiring around it. Not yet run against a live Soroban RPC, Solana validator, or Redpanda cluster (no local Stellar quickstart or solana-test-validator was available in this build's environment — see individual module doc comments, e.g. `packages/chain-adapters/src/stellar/decode-soroban-events.ts`, for exactly what is and isn't independently verified).

**Known gap**: nothing yet consumes the event backbone to populate `packages/db`'s tables (the "Kafka→DB projector" implied by docs/architecture.md §8's service table). `apps/api` currently only reads whatever a DB seed/migration puts in Postgres; `apps/solver` reads intents directly off live events instead of via the DB for this reason. This projector is the natural next piece of backend work.

**Not yet built**: `apps/web` (frontend), `apps/arbiter-service`, Terraform/observability (hardening phase).
