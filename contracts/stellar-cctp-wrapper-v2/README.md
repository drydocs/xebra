# stellar-cctp-wrapper-v2

The forwarding version of `XebraCctpWrapper`. **Live on Stellar mainnet** at
`CCPVTWII2TW6VVSVA4JQ2KFHICGBG4QVAHPIGUPSIW3E4VNPUI4Y2WQR` (`cctpWrapperV2` in
`deployments/mainnet.json`); the web app has used it since 2026-09-30, and v1
(`../stellar-cctp-wrapper`) is retired. It is a new contract at a new id, because a contract that
holds no funds between transactions needs no migration and editing v1 in place would break its
pinned WASM hash.

Read [`docs/forwarding-wrapper.md`](../../docs/forwarding-wrapper.md) first. It has the reasoning,
the fee model, the measured behaviour of Circle's Forwarding Service, and the testnet and mainnet
results.

## What differs from v1

For a destination the admin marks `forward`, `bridge` calls Circle's
`deposit_for_burn_with_hook` with the fixed `FORWARD_HOOK`; Circle's infrastructure then mints on
the destination and takes its fee out of the minted amount. Everything else — the user as
`caller`, `destination_caller` zero, no custody of principal, the immutable `usdc` and
`token_messenger`, the 48h timelock — is v1 unchanged.

- `DomainCfg` gains `forward` and `max_forward_fee` (a per-chain cap on the signed `max_fee`).
- The fee the user sees is unchanged: the recipient gets `amount − fee`. Circle's forward fee is
  paid **out of** that fee, so Xebra keeps `fee − forward_fee`.
- **Circle charges the whole `max_fee`**, so a signed `max_fee` is a price the recipient pays. It is
  bounded by the domain's cap (itself under a compile-time ceiling, `MAX_FORWARD_FEE_CEILING`) and
  by a tenth of the burn.
- A first-time Solana recipient is forwarded too, with Circle's 65-byte extended hook (built here from
  the signed `recipient_owner`, never from caller-supplied data) that makes Circle's forwarder create
  the token account. That path has its own fee cap. With `account_creation` off on the domain, such a
  recipient takes the plain path, which nobody mints (there is no relay), so the web app refuses it.
- `tighten_domain` (admin **or pauser**, instant) turns forwarding off or lowers a cap. It can never
  loosen. Loosening is `propose_domain` under the timelock, and `cancel_pending` vetoes it.
- `quote` now takes the destination and `max_fee`, since on the forward path the price depends on
  both.

## Build and test

```bash
cargo test                                       # 84 tests: 41 inherited from v1, 43 new
cargo build --release --target wasm32v1-none     # -> target/.../xebra_cctp_wrapper_v2.wasm
```

Locally, point `CARGO_TARGET_DIR` at v1's `target/` to reuse its compiled Soroban SDK instead of
rebuilding it.
