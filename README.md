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
  projector/              # Kafka->DB projector — populates packages/db from the event backbone
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
- `apps/web` — Next.js frontend, **produces a real successful production build** (`pnpm build`), not just a typecheck; two build-breaking issues (a wagmi dependency-bundling failure, an SSR `window` crash) were found and fixed by actually running it rather than trusting the code by inspection. See `apps/web/README.md`.
- `packages/arbiter-signer` — KMS-backed EVM (secp256k1) + Stellar (Ed25519) signer adapters for the v1 arbiter. No real KMS available, so tested against genuine keypairs/signatures via `@noble/curves` standing in for KMS responses — real DER parsing, real recovery-bit math, real low-S normalization, not mocked success responses.
- `apps/arbiter-service` — KMS-backed `resolve()` submitter for both escrows (viem custom account + Soroban tx signing), wired to live `IntentChallenged` events. The actual claim-verification step isn't wired yet — see the module doc comment in `apps/arbiter-service/src/index.ts`.
- `apps/projector` — the "Kafka→DB projector" that was the previous known gap: consumes the event backbone and populates `packages/db`'s `intents`/`escrow_events` tables. **Verified against a live Postgres** (podman) — inserted a real `IntentOpened` event, confirmed the row and its corridor mapping, confirmed redelivering the same event is a no-op (idempotency), then advanced status via a later event and confirmed `escrow_events` appended correctly. `apps/api` and `apps/solver` don't consume from it yet (still read a manual seed / raw events respectively — see below).

**Known gap, narrowed**: the projector above only populates `intents.status` and `escrow_events`, not the `claims` table (solver address, delivered amount, challenge bond/timestamps — a second per-chain payload mapping in the same shape as `project-intent-opened.ts`'s Arc/Soroban split, not yet written). This is what still blocks `apps/arbiter-service` from looking up a challenged claim's destination-chain proof, and what `apps/api`/`apps/solver` would need to fully switch over from their current manual-seed / raw-event workarounds to reading the DB.

- `contracts/arc-evm/script/DisputeWalkthrough.s.sol` — live dispute walkthrough (false delivery claim -> challenge -> arbiter `resolve(false)` -> refund/slash), asserted on-chain via `require()` and run successfully against a real anvil instance, not just narrated. The Soroban side already has an equivalent case (`dispute_resolve_invalid_refunds_user_slashes_liar` in `contracts/stellar-soroban/src/test.rs`) from the Phase 1 work.
- `infra/terraform` — full staging/production IaC: `network` (VPC, public/private subnets, NAT), `database` (RDS Postgres 17), `cache` (ElastiCache Redis), `kms` (Ed25519 + secp256k1 arbiter keys), `ecs-service` (reusable Fargate module), ECR repos per service, ALBs for `apps/api` and `apps/web`, and root wiring for all nine services. `terraform validate` passes for real against the `hashicorp/aws` provider (a genuine bug — the pinned 5.x provider doesn't recognize `ECC_NIST_EDWARDS25519` as a valid KMS key spec — was caught this way and fixed by moving to provider `~> 6.60`, which does). No `plan`/`apply` was run (no real AWS credentials in this environment); `environments/*.tfvars.example` documents what a real deploy needs.

- `packages/observability` — shared OTel wiring (`startObservability`, `registerPolledGauge`) for traces/metrics over OTLP/HTTP to Grafana Cloud, no auto-instrumentation. **Live-verified**: a test spins up a real local HTTP server standing in for the OTLP gateway and asserts the SDK actually POSTs to `/v1/metrics`, not just that it constructs without throwing. Wired into all eight backend services (`api`, `solver`, `cctp-relay`, `arbiter-service`, `projector`, `indexer-arc`, `indexer-stellar`, `indexer-solana`); `apps/web` isn't wired yet (Next.js needs a different mechanism — `instrumentation.ts`/`@vercel/otel` — not this package directly). All five day-one alerts from docs/architecture.md §11 now have a real signal behind them: relay SOL balance (`cctp-relay`, polled gauge), solver per-mint inventory (`solver` — this also replaced a hardcoded `getBalance: async () => 2n ** 64n` placeholder with a real SPL token-account balance check), CCTP attestation-pending age (`cctp-relay`'s worker, using a new `createdAt` field on `RelayJobState`), unclaimed-intents-nearing-window-close (`projector`, a real DB query with a unit-tested pure counting function), and arbiter KMS failures (`arbiter-service`, counter around the startup KMS calls — the resolve-path Sign calls aren't reachable yet, same gap as before).

**Not yet built**: `apps/web`'s OTel wiring, recorded e2e demo.
