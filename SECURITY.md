# Security

Xebra moves real money on Stellar mainnet and Solana mainnet. Every issue here starts from that.

## Scope

| Component | Address / location | Notes |
|---|---|---|
| `XebraCctpWrapper` (Soroban) | `CCNWLGFMILJU476RZHDA2PSUH2WH3LIPERHS6BYPCRVDDYYNNUIKZMTJ` (see [`deployments/mainnet.json`](./deployments/mainnet.json)) | live on Stellar mainnet, takes a fee and hands the burn to Circle's CCTP in one transaction |
| Relay (`apps/web/convex/`) | production deployment `knowing-zebra-183` | watches burns, waits on Circle's attestation, pays the Solana mint from a hot wallet |
| Frontend (`apps/web`) | [xebra-sandy.vercel.app](https://xebra-sandy.vercel.app/) | builds the signed request the wallet submits |

`contracts/arc-evm` (XebraEscrow.sol) and `contracts/stellar-soroban` are part of the Arc↔Stellar
corridor, which is not on the deployment path (see the README's "Repo layout" section) — real bugs
there are still worth reporting, but nothing user-facing depends on them today.

## What's most worth finding

- Anything that lets the wrapper move a user's **principal**, not just the fee. By design
  (`contracts/stellar-cctp-wrapper/src/lib.rs`), the user is `caller` on `deposit_for_burn` and the
  wrapper only ever pulls `q.fee` — a bug that breaks that boundary is the highest-severity class
  of report this project has.
- Anything that lets a mint be double-paid, redirected, or paid to the wrong domain/recipient shape.
- Anything that lets `withdraw_fees`, the timelocked admin functions, or `pause`/`unpause` be
  reached without the intended `require_auth`.
- Relay logic that could double-submit a mint, get stuck retrying forever (see
  [`writeups/04-thirty-two-bytes.md`](./writeups/04-thirty-two-bytes.md) for a real prior instance
  of this class of bug), or leak `RELAY_SOLANA_KEYPAIR` / `RELAY_SUBMIT_TOKEN`.
- Anything that lets a burn not made through this wrapper get sponsored (see
  [`docs/go-live.md`](./docs/go-live.md) §3 for the current bound-not-authenticated posture of
  `/api/relay/burns`).

The contract has had **no external audit**. `MAX_TRANSFER` is deliberately kept low while that's
true — see [`docs/go-live.md`](./docs/go-live.md) §1. A formal bug bounty is planned
(`docs/go-live.md` §7) but not yet published; until it is, this document is the reporting process.

## Reporting

**Do not open a public GitHub issue for anything that could let someone take user funds, drain the
relay's hot wallet, or bypass the admin/pauser timelock.** Use GitHub's private vulnerability
reporting (Security tab → "Report a vulnerability") if enabled on this repo, or email
egwomevan323@gmail.com with:

- which component (contract, relay, frontend) and, for the contract, which function
- the precondition and the concrete sequence of calls or transactions that trigger it
- what an attacker or a buggy client gains

Non-security bugs (a UI glitch, a misleading error, a typo) belong in a regular GitHub issue —
see [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Response

This is a solo-maintained project. There's no formal SLA yet, but a fund-affecting report gets
looked at first — if it's real, `pause()` (immediate, no timelock — see
[`docs/GOVERNANCE.md`](./docs/GOVERNANCE.md)) is the first response, before anything else.

## Keys

`ADMIN` and `PAUSER` are held by different keys, specifically so a compromised admin can still be
stopped (`docs/go-live.md` §2). The relay's Solana hot wallet is meant to hold only enough for a
handful of transfers and reaches the relay through Convex's encrypted environment, never a
committed file or a container image — `.secrets/` is git-ignored for exactly this reason and
should stay that way in any fork.
