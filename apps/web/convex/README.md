# convex/

Relay state and the relay's scheduler. `apps/web` serves the UI; this runs the pipeline.

## Before anything typechecks here

`_generated/` does not exist in a fresh checkout — Convex writes it from `schema.ts` and the
function signatures, against your own deployment:

```bash
cd apps/web
npx convex dev        # first run: logs in, creates the project, writes _generated/
```

That is also why `apps/web/tsconfig.json` excludes this directory: the Next.js build must not
depend on files a contributor has not generated yet, and nothing under `app/` imports the
generated API. The route handler reaches these functions by name through
`makeFunctionReference`, which needs no codegen.

## What is public

Exactly one function: `relay.submitBurn`. Everything else is `internal*` and unreachable from a
browser — they would otherwise let a caller create or complete jobs directly, which is to say
spend the relay's SOL.

`submitBurn` is public because the browser calls it after signing a burn, and it is bounded
rather than authenticated. See `packages/relay-core/src/admission.ts` for why, and for what those
bounds do not achieve.

## Bundling

`convex.json` marks `@solana/web3.js` and `@stellar/stellar-sdk` as external packages: Convex
installs them from npm on its side rather than bundling them into the action. They are large and
carry dynamic requires, which is exactly what external packages are for.

The `@xebra/*` packages must NOT be external — they are `workspace:*` and do not exist on npm, so
Convex bundles them inline from `dist/`. That means **the workspace packages have to be built
before `npx convex dev` or `npx convex deploy`**:

```bash
pnpm --filter @xebra/web^... build
```

## Environment variables

Set on the Convex deployment (`npx convex env set NAME value`), not in Vercel — these are read by
the actions here:

| | |
|---|---|
| `RELAY_SOLANA_KEYPAIR` | Required. The hot wallet that pays for mints |
| `SOLANA_RPC_URL` | Required |
| `SOLANA_USDC_MINT` | Required |
| `IRIS_BASE_URL` | Defaults to production Iris. The sandbox leaves burns pending forever |
| `HORIZON_URL`, `SOROBAN_RPC_URL` | Default to mainnet |
| `STELLAR_CCTP_DOMAIN_ID` | Defaults to 27 |
| `STELLAR_CCTP_WRAPPER_CONTRACT_ID`, `SOROBAN_START_LEDGER` | Both needed before the burn watcher runs at all |
| `RELAY_SUBMIT_TOKEN` | Optional. Bypasses the admission bounds, for operations |

Vercel needs `NEXT_PUBLIC_CONVEX_URL` (or `CONVEX_URL`) pointing at this deployment.
