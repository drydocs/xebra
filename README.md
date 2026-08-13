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

Scaffold in progress — see `docs/architecture.md` for the phased delivery plan. Corridor 1 (Arc→Stellar) contracts and Corridor 2 (Stellar→Solana) contracts are being built out per that plan; nothing here is deployed to a public network yet.
