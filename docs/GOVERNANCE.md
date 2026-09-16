# Governance

Who can change what on the deployed `XebraCctpWrapper` contract, and how fast. Everything here is
enforced on-chain, in `contracts/stellar-cctp-wrapper/src/lib.rs` — this document names it, it
doesn't grant it.

## Two roles, deliberately separate

| Role | Can do | Held by |
|---|---|---|
| **ADMIN** | propose/commit parameter, admin, pauser, fee-recipient, and domain changes; withdraw accrued fees; unpause | see [`deployments/mainnet.json`](../deployments/mainnet.json) |
| **PAUSER** | `pause()` only — immediately, no timelock | see [`deployments/mainnet.json`](../deployments/mainnet.json) |

**`ADMIN` and `PAUSER` must be different keys held by different people.** The pauser exists so a
compromised admin can still be stopped by someone who is not the attacker. The deploy script
(`scripts/deploy-cctp-wrapper.sh`) warns if they match but cannot enforce the separation — it
can't know who actually holds each key.

Current holders are whatever is recorded in `deployments/mainnet.json` at time of reading; this
document intentionally doesn't duplicate the addresses so it can't go stale the way the README's
status table once did.

## The timelock

Every admin action except pausing follows the same two-step, 48-hour pattern
(`TIMELOCK_SECS = 172_800` in `lib.rs`):

1. **Propose** — `propose_params`, `propose_admin`, `propose_pauser`, `propose_fee_recipient`, or
   `propose_domain`. Requires `ADMIN`'s auth. Records the change and an `eta` 48 hours out.
2. **Commit** — `commit_params`, `accept_admin` (requires the *new* admin's own auth, not the old
   admin's), `commit_pauser`, `commit_fee_recipient`, or `commit_domain`. Fails if called before
   `eta`.

`cancel_pending` lets `ADMIN` withdraw a proposal before it commits. `tighten_params` is the one
exception: it can only make limits *stricter* (lower `max_transfer`, higher `min_fee`, etc.), never
looser, so it skips the timelock — a safety ratchet, not a bypass.

**Pausing is immediate and untimelocked, on purpose.** `pause(caller)` checks `caller` is either
`ADMIN` or `PAUSER` and takes effect in the same transaction. Everything else — including
`unpause` — needs `ADMIN` and, if it's a parameter change, the full 48 hours.

## Why it's shaped this way

A fee-taking contract with a fixed `MAX_TRANSFER` and no external audit
(see [`SECURITY.md`](../SECURITY.md)) needs two different response speeds: *stop it now* if
something looks wrong, and *change it deliberately* for everything else, with enough delay that
users and other maintainers have a window to notice and react before a parameter change takes
effect. 48 hours is chosen to be long enough to notice, short enough to still be useful.

## What this doesn't cover

The relay (`apps/web/convex/`) and frontend (`apps/web`) have no on-chain governance — they're
ordinary deployed software, changed by ordinary PRs and deploys. Nothing about them requires a
timelock because they hold no funds and confer no authority the contract doesn't independently
check; the contract is the only thing here whose bugs are irreversible by design.
