# @xebra/stellar-soroban

`XebraEscrow` (Soroban/Rust) — Stellar-as-source escrow for the Stellar→Solana corridor. Mirrors
`contracts/arc-evm`'s state machine and economics; see the module doc comment at the top of
`src/lib.rs` for exactly where and why the two diverge (signing, bonds, decimals, storage TTL,
destination proof reference).

## Test

```bash
cargo test
```

14 tests, including both dispute outcomes, nonce replay, expired-intent and wrong-source-token
rejection, double-claim rejection, and the bond-floor calculation. `open`'s signature check and
`resolve`'s arbiter check are Soroban-host-enforced (`require_auth`/`require_auth_for_args`), not
hand-rolled contract logic, so — unlike the Arc test suite — there's no "bad signature" or
"wrong arbiter" contract-logic branch to unit test here; that verification lives in the host.

## Build (wasm)

```bash
cargo build --release --target wasm32v1-none
```

Requires Rust 1.84+ (`wasm32-unknown-unknown` is **not** supported by the Soroban environment on
recent rustc — see the comment in `Cargo.toml`; use `wasm32v1-none`).

## Deploy

```bash
stellar contract deploy \
  --wasm target/wasm32v1-none/release/xebra_escrow_soroban.wasm \
  --source <deployer-key> \
  --network testnet \
  -- \
  --usdc <usdc-sac-address> \
  --arbiter <arbiter-address> \
  --challenge-window-secs 1800
```
