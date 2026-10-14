# Contributing

Xebra bridges real USDC on mainnet. That changes what "move fast" means here — see
[`SECURITY.md`](./SECURITY.md) before anything else if what you found could touch user funds.

## Setup

```bash
pnpm install
cp .env.production.example .env.production   # public mainnet constants; never a secret
pnpm --filter @xebra/web dev
```

`pnpm dev` points the UI at real mainnet contracts. Browsing is safe — quotes are Soroban
simulations and nothing moves until a signature — but a signed transaction spends real USDC. Don't
sign with a wallet that holds money you're not willing to move while testing.

Full setup, including the optional Convex rate counter, is in the README's
["Getting started"](./README.md#getting-started).

## Before opening a PR

```bash
pnpm lint        # biome, whole repo
pnpm typecheck    # every workspace package
pnpm test         # vitest + cargo test + forge test
pnpm check:env    # no secrets in env files, coherent config
```

CI (`.github/workflows/ci.yml`) runs all of these on every push. A PR that doesn't pass them won't
merge — run them locally first, it's faster than the round trip. CI does not run `pnpm check:cctp`,
`pnpm check:arc` or `pnpm check:evm`, which read the live chains; run the relevant one yourself if you
touch the wrapper's Circle interface or the pinned chain constants.

If you touch `contracts/stellar-cctp-wrapper-v2` (the live wrapper) or
`contracts/stellar-cctp-wrapper` (v1, retired), add or update a test in its `src/test.rs` for the
exact behavior you changed. The [`writeups/`](./writeups/) directory is the record of what a
passing test suite still missed in this contract before — read `02-the-tests-that-lied.md` before
assuming a green suite means done.

## Scope

The deployment path is the wrapper contract (v2), the Iris rate counter (`apps/web/convex/`), and
the frontend (`apps/web`) — see the README's "Repo layout" for what's on it versus what's in the
repo but not deployed (the Arc↔Stellar corridor and the container stack). PRs against either are
welcome; just say in the PR which side you're touching, since the deployed side has a materially
higher bar (see `SECURITY.md`).

## Opening a PR

- One focused change per PR. Link an issue if there is one; open one first for anything nontrivial
  so the approach can be discussed before the code is written.
- Explain *why*, not just what — the same standard the code comments in this repo hold themselves
  to.
- If the change affects fee math, CCTP message construction, the pinned chain table, or anything in
  `contracts/stellar-cctp-wrapper-v2`, say so explicitly in the PR description. Those get read more
  carefully, on purpose.

## Reporting bugs

Non-security bugs: open a GitHub issue with what you expected, what happened, and how to reproduce
it. Fund-affecting bugs: see [`SECURITY.md`](./SECURITY.md) instead — not a public issue.

## Code of conduct

This project follows the [Contributor Covenant](./CODE_OF_CONDUCT.md).
