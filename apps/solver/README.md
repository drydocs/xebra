# @xebra/solver

Multi-chain fill bot. v1 scope: Stellar→Solana only (this build's new corridor).

`fill-loop.ts` is the tested orchestration core (`processOpenedIntent`: quote → fill → claim,
against injected `FillAdapter`/`ClaimAdapter` interfaces — 4 tests, no live network needed).
`adapters/solana-fill.ts` and `adapters/stellar-claim.ts` are the concrete v1 implementations:

- **Solana fill**: direct-inventory-match delivery (ATA-create + transfer + memo, via
  `@xebra/chain-adapters`). `quote()` is unit-tested (3 tests); `fill()` signs and submits a
  real transaction and isn't exercised live here (no Solana validator available in this build's
  environment). Jupiter swap-route splicing for "solver only holds USDC" isn't implemented yet.
- **Stellar claim**: calls `claim` on the Stellar-source XebraEscrow via `@stellar/stellar-sdk`
  (`Contract.call` + `TransactionBuilder` + `rpc.Server.prepareTransaction`/`sendTransaction`,
  compiled against the real SDK types). Not exercised against a live Soroban RPC.

`decode-intent-event.ts` reconstructs an `IntentV2` directly from a live `IntentOpened`
`ChainEvent`'s payload (5 tests) rather than reading it back from Postgres — see the repo
README's Status section for why (the Kafka→DB projector that would populate `intents` doesn't
exist yet).

Inventory tracking (`getBalance` in `index.ts`) is a placeholder returning "always sufficient" —
wiring real SPL balance checks is a `TODO` there.
