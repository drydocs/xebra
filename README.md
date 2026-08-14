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
- `packages/intent-schema`, `router-core`, `chain-adapters`, `cctp-client`, `event-bus`, `db` — all with real logic and tests; `chain-adapters`' Arc log decoding is proven against a real anvil-deployed contract (`arc/decode.live.test.ts`); `db`'s schema has been migrated onto and queried against a live Postgres. `chain-adapters`' Soroban event decoding (`decode-soroban-events.ts`) is now also proven against real testnet events (see `scripts/e2e-demo/`) — that live check caught and fixed a real bug (event topics are snake_case, e.g. `intent_opened`, not the PascalCase `IntentOpened` the original code guessed), which had been silently dropping every Soroban event indexer-stellar would ever see.
- `apps/api` — tRPC + Postgres, run live end-to-end against a seeded database.
- `apps/cctp-relay`, `apps/indexer-arc`, `apps/indexer-stellar`, `apps/indexer-solana`, `apps/solver` — real orchestration logic (each unit-tested with injected/mocked chain clients), thin live wiring around it. Not yet run end-to-end against a live Solana validator or Redpanda cluster; the Soroban RPC piece specifically now has live-verified decoding (see above).
- `apps/web` — Next.js frontend, **produces a real successful production build** (`pnpm build`), not just a typecheck; two build-breaking issues (a wagmi dependency-bundling failure, an SSR `window` crash) were found and fixed by actually running it rather than trusting the code by inspection. See `apps/web/README.md`.
- `packages/arbiter-signer` — KMS-backed EVM (secp256k1) + Stellar (Ed25519) signer adapters for the v1 arbiter. No real KMS available, so tested against genuine keypairs/signatures via `@noble/curves` standing in for KMS responses — real DER parsing, real recovery-bit math, real low-S normalization, not mocked success responses.
- `apps/projector` — consumes the event backbone and populates `packages/db`'s `intents`, `escrow_events`, and now `claims` (`project-claim.ts`: solver address, delivered amount, bond, challenge status/timestamps — the same Arc-vs-Soroban payload-shape split as `project-intent-opened.ts`). **Verified against a live Postgres** (podman): inserted a real `IntentOpened` event, confirmed idempotent redelivery, advanced status via a later event, and — new — projected a full `claims` row through `claimed -> challenged -> resolved` and asserted each field at each step. `apps/api`/`apps/solver` still read a manual seed / raw events rather than this DB (a real remaining gap, unchanged).
- `apps/arbiter-service` — KMS-backed `resolve()` submitter for both escrows, wired end-to-end for the Stellar->Solana corridor: `lookupClaim` (the join this file's own doc comment named as blocking it) against the now-populated `claims` table, `verifyClaimAgainstDestinationChain` (fetches the real Solana tx and runs `@xebra/chain-adapters`' `verifyDelivery` against it — unit-tested with a realistic parsed-tx fixture), then `decideClaimValidity` and the real `resolveOnArc`/`resolveOnSoroban` submission. The existing Arc->Stellar corridor's Horizon-based verification is explicitly out of scope here and still logs-and-skips (documented in `verify-claim.ts`), and a `arbiter_pending_challenges` gauge tracks challenges that couldn't be resolved yet (missing claim row or unverifiable destination).

- `contracts/arc-evm/script/DisputeWalkthrough.s.sol` — live dispute walkthrough (false delivery claim -> challenge -> arbiter `resolve(false)` -> refund/slash), asserted on-chain via `require()` and run successfully against a real anvil instance, not just narrated. The Soroban side already has an equivalent case (`dispute_resolve_invalid_refunds_user_slashes_liar` in `contracts/stellar-soroban/src/test.rs`) from the Phase 1 work.
- `infra/terraform` — full staging/production IaC: `network` (VPC, public/private subnets, NAT), `database` (RDS Postgres 17), `cache` (ElastiCache Redis), `kms` (Ed25519 + secp256k1 arbiter keys), `ecs-service` (reusable Fargate module), ECR repos per service, ALBs for `apps/api` and `apps/web`, and root wiring for all nine services. `terraform validate` passes for real against the `hashicorp/aws` provider (a genuine bug — the pinned 5.x provider doesn't recognize `ECC_NIST_EDWARDS25519` as a valid KMS key spec — was caught this way and fixed by moving to provider `~> 6.60`, which does). No `plan`/`apply` was run (no real AWS credentials in this environment); `environments/*.tfvars.example` documents what a real deploy needs.

- `packages/observability` — shared OTel wiring (`startObservability`, `registerPolledGauge`) for traces/metrics over OTLP/HTTP to Grafana Cloud, no auto-instrumentation. **Live-verified**: a test spins up a real local HTTP server standing in for the OTLP gateway and asserts the SDK actually POSTs to `/v1/metrics`, not just that it constructs without throwing. Wired into all eight backend services (`api`, `solver`, `cctp-relay`, `arbiter-service`, `projector`, `indexer-arc`, `indexer-stellar`, `indexer-solana`); `apps/web` isn't wired yet (Next.js needs a different mechanism — `instrumentation.ts`/`@vercel/otel` — not this package directly). All five day-one alerts from docs/architecture.md §11 now have a real signal behind them: relay SOL balance (`cctp-relay`, polled gauge), solver per-mint inventory (`solver` — this also replaced a hardcoded `getBalance: async () => 2n ** 64n` placeholder with a real SPL token-account balance check), CCTP attestation-pending age (`cctp-relay`'s worker, using a new `createdAt` field on `RelayJobState`), unclaimed-intents-nearing-window-close (`projector`, a real DB query with a unit-tested pure counting function), and arbiter KMS failures (`arbiter-service`, counter around the startup KMS calls — the resolve-path Sign calls aren't reachable yet, same gap as before).

`apps/web` is now wired too, via Next.js's `instrumentation.ts` hook (`register()`, gated to the nodejs runtime, dynamically importing `@xebra/observability` rather than a top-level import) — confirmed with a real `pnpm build` (exit 0, same class of pre-existing non-fatal webpack "critical dependency" warnings the wagmi/stellar-sdk chain already produced, nothing new broken).

- `scripts/e2e-demo/` — **live** end-to-end run of the Stellar-source escrow's full happy path (`open -> claim -> finalize`) against real Stellar testnet infrastructure, not a local simulator: a contract deployed to testnet, a real `require_auth_for_args` signature verified by a live host (closing an open risk flagged since Phase 1 — this had previously only run under Rust's `mock_all_auths()` test harness), a real 60-second challenge window waited out for real, and `finalize` called by a third-party identity to prove it's genuinely permissionless. All five transactions are linked and explained in `scripts/e2e-demo/README.md`, verifiable independently on stellar.expert. The Solana devnet leg (real delivery tx with a memo) is implemented and ready to run (`01-solana-setup.ts`) but didn't complete in this environment — devnet's public airdrop faucet returned a hard daily rate limit on every attempt, documented in that README along with the placeholder values used in its place and exactly what to substitute once SOL is available.

**Not yet built**: nothing from the original hardening list — the Solana leg of the e2e demo above is the one item blocked by an external constraint (a faucet rate limit) rather than by code.
