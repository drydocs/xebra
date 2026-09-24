# Deploying

Two services, both with free tiers: **Vercel** serves the UI, **Convex** runs the relay and holds
its state. There is no AWS, no Docker, no Redis, no Kafka and no Postgres in this deployment.

## How the relay runs without a server

`apps/cctp-relay` is a long-running process — a BullMQ worker on Redis, a watcher loop, a
container. Nothing here runs containers, so the pipeline in `@xebra/relay-core` is driven by
Convex instead:

| | |
|---|---|
| `relay.submitBurn` (action, public) | Records a burn and mints it in the same call. The fast path. |
| `relay.tick` (action, internal) | Scans for new burns, drains anything due. Every minute, from `crons.ts`. |
| `jobs.*`, `cursors.*` (internal) | State. Serializable mutations, so a read-then-write is atomic. |

`apps/web/app/api/relay/burns` is a thin proxy so the page talks to its own origin and
`RELAY_SUBMIT_TOKEN` has somewhere to live that is not a browser.

Everything that moves money — `processJob`, `advanceRelayJob`, `scanForBurns`,
`checkBurnAdmission`, the `receiveMessage` instruction — is shared with the container relay,
unmodified. Convex supplies storage adapters and config; that is all.

### Why Convex and not Postgres

The relay is a retrying job pipeline that must survive between invocations. Postgres can do that,
but on serverless every part of making it safe is work spent on the storage engine rather than the
corridor: a connection per invocation, `FOR UPDATE SKIP LOCKED` to keep overlapping workers apart,
a polling column standing in for a scheduler.

Convex gives serializable mutations, so `upsertBySourceTx` — the whole idempotency guarantee, the
thing that stops a burn being minted twice — is just a read and a write in one transaction. And
its cron runs **every minute on the free plan**, where Vercel Cron on Hobby runs **once per day**.
A daily retry cadence is not a product.

One thing Convex does not remove: actions are *not* transactional, because they call Iris and
Solana and a retry would submit a mint twice. That is why `jobs.claimDue` hands out a lease before
any action touches a job.

`@xebra/relay-core/postgres` still exists for anyone self-hosting the container. Both satisfy the
same interfaces.

## Setup

### 1. Convex

```bash
pnpm --filter @xebra/web^... build   # convex bundles the workspace packages from dist/
cd apps/web
npx convex dev                       # logs in, creates the project, writes convex/_generated/
```

`_generated/` is not in the repo — it is written against your own deployment. `apps/web`'s
tsconfig excludes `convex/`, and the route handler reaches Convex by name through
`makeFunctionReference`, so the Next.js build does not depend on having run this.

Then set the relay's environment on the Convex deployment — **not** in Vercel:

```bash
npx convex env set RELAY_SOLANA_KEYPAIR "<base58 | base64 | keygen JSON array>"
npx convex env set SOLANA_RPC_URL       "https://api.mainnet-beta.solana.com"
npx convex env set SOLANA_USDC_MINT     "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
```

To also mint on Arc, give the relay an Arc key. Without it the relay serves Solana only, and a
burn addressed to Arc retries with a readable error until the key appears:

```bash
npx convex env set RELAY_ARC_PRIVATE_KEY "<32-byte hex private key>"
```

Fund that address with USDC on Arc — USDC is Arc's gas token, and a mint costs well under a cent.
`docs/go-live.md` has the full order of operations, including the on-chain step that must come
first.

Optional, each defaulting to the pinned mainnet constant: `IRIS_BASE_URL`, `HORIZON_URL`,
`SOROBAN_RPC_URL`, `STELLAR_CCTP_DOMAIN_ID`, `ARC_RPC_URL`, `RELAY_SUBMIT_TOKEN`. Two more are needed only once
the wrapper contract is deployed, and the burn watcher stays off until both are set:
`STELLAR_CCTP_WRAPPER_CONTRACT_ID` and `SOROBAN_START_LEDGER`.

`npx convex deploy` pushes to production and starts the cron.

### 2. Vercel

Import the repo and set **Root Directory to `apps/web`**, with "include files outside the root
directory" enabled so the workspace packages resolve.

`vercel.json` deliberately sets no `outputDirectory`. Every path in it resolves *relative to the
root directory*, so naming `apps/web/.next` there produces `apps/web/apps/web/.next` and the
deploy fails after a completely successful build — the build log shows every route compiled and
then an error about a missing output directory. Vercel's Next.js preset already knows the default
is `.next` under the root.

Public variables, inlined into the browser bundle at build time — so they must be set **before**
the first build, not after. Copy them from `.env.production`:

```
NEXT_PUBLIC_NETWORK
NEXT_PUBLIC_SOROBAN_RPC_URL
NEXT_PUBLIC_HORIZON_URL
NEXT_PUBLIC_STELLAR_NETWORK_PASSPHRASE
NEXT_PUBLIC_STELLAR_USDC_SAC_ADDRESS
NEXT_PUBLIC_STELLAR_TOKEN_MESSENGER_ADDRESS
NEXT_PUBLIC_SOLANA_CCTP_DOMAIN_ID
NEXT_PUBLIC_SOLANA_RPC_URL
NEXT_PUBLIC_SOLANA_USDC_MINT
NEXT_PUBLIC_STELLAR_CCTP_WRAPPER_CONTRACT_ID   # empty until the wrapper is deployed
```

Server-side only:

| | |
|---|---|
| `CONVEX_URL` | The deployment URL from `npx convex deploy` |
| `RELAY_SUBMIT_TOKEN` | Optional, and only if you set one in Convex too |

### 3. Check it

```bash
npx convex run relay:tick          # from apps/web
```

`{"status":"ok",...}` means the relay is configured and reachable. `unconfigured` names the
missing variable. `npx convex logs` follows the cron.

## What each plan costs

**Convex free:** 1M function calls and 20 GB-hours of action compute per month, 0.5 GB storage. A
minute-cron is about 43,000 calls a month, so the relay lives well inside it.

**Vercel Pro, $20/month — for the terms, not the features.** Vercel's fair-use guidelines restrict
Hobby to non-commercial, personal use, and charging a bridge fee is commercial. Hobby is fine while
you are moving your own money to test; because the schedule lives in Convex, a Hobby deployment is
functionally complete rather than crippled.

## The relay's exposure, stated plainly

Every mint costs the hot wallet 867,621 lamports of permanent rent plus fees, and up to 2,039,280
more if the recipient has no USDC account yet. None of it is recoverable.

Until the wrapper contract is deployed, nothing on chain distinguishes a burn made through this app
from any other CCTP user's burn on Stellar — Circle's contract serves everyone. So `submitBurn`
cannot tell whose mint it is being asked to pay for. It is bounded rather than authenticated: a
burn older than an hour is refused, and sponsorship stops after 200 mints in 24 hours.

A determined griefer inside those bounds can still get a bounded number of their own transfers
sponsored. **Deploying the wrapper is what removes this**, because the watcher then only ever sees
burns we were paid a fee on. It is on the launch path in `docs/go-live.md` for revenue reasons;
this is the second reason.

Refusing to sponsor never strands anyone. The burn stays claimable by whoever holds Circle's
attestation, which is public and never expires.

## Two build details

**`build:vercel` exists because of the dist directory.** Locally, `pnpm build` writes to
`.next-build`, so a production build cannot wipe the directory a running `next dev` is serving
from — when it does, every request fails with `ENOENT: routes-manifest.json`, the build looks
fine, the dev server looks broken, and nothing in either message points at the other process. On
Vercel there is no dev server to protect and Vercel expects `.next`.

**`.env.production` is not in the repo**, deliberately — a `.env` in git reads as a mistake
whatever it contains. `scripts/with-env.mjs` treats a missing file as "use the environment" when
`NETWORK` or `NEXT_PUBLIC_NETWORK` is already set, and still fails loudly on a local checkout where
neither is.

## If the relay is unavailable

`/claim` completes a transfer from the user's own wallet. It fetches Circle's attestation, builds
the same `receiveMessage` instruction the relay builds, and has the connected wallet sign and pay.
The receipt links to it with the burn hash already filled in.

The payer does not have to be the recipient: `receiveMessage` mints to the address the burn named
whoever submits it, so a third party can rescue someone else's stuck transfer. When the recipient
has no USDC account yet, the page asks for the destination wallet — a token account address cannot
be reversed into its owner, so there is no way to create one without being told — and checks the
derived address against the burn before anything is signed.

Two server routes exist for it, both because the browser cannot do the work directly:
`/api/attestation` keeps the Iris URL out of the bundle, and `/api/solana-rpc` is a
method-restricted pass-through, because Solana's public RPC answers the CORS preflight with 200
and then **403s the actual POST** whenever an `Origin` header is present.

## Alerting

The hot wallet is the thing most likely to break this in production. It drains by design — every
mint burns 867,621 lamports of rent nobody gets back — and when it empties, **every transfer stalls
silently**: a job that cannot be paid for is indistinguishable from one waiting on Circle's
attestation, so nothing errors and nobody notices until a user complains.

Two things watch it, both free:

- A Convex cron every 15 minutes that **throws** when the balance is critical, so it shows as a
  failed function in the dashboard rather than a log line nobody reads.
- `GET /api/health`, which returns **503** when the relay cannot do its job. Point any free uptime
  monitor at it — 503 is the one signal they all understand without configuration.

Thresholds come from the measured cost of a mint (`packages/relay-core/src/health.ts`): critical is
two worst-case transfers left, warning is ten. The response says how many transfers remain, not
just a lamport count, because that is the number that tells you whether to act now.

## What is still missing

**The relay has never run against a live Convex deployment.** That needs your login. Everything
here is unit-tested and none of it has talked to a real database.
