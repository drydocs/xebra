# Deploying on Vercel

There is no AWS, no Docker, no Redis and no Kafka in this deployment. The product is one Next.js
app plus a Postgres database, and the relay runs as two route handlers.

## How the relay works without a server

`apps/cctp-relay` is a long-running process — a BullMQ worker on Redis, a watcher loop, a
container. Vercel has no long-lived process and no Redis, so the pipeline in
`@xebra/relay-core` is driven from route handlers instead:

| | |
|---|---|
| `POST /api/relay/burns` | Records a burn and mints it in the same request. The fast path. |
| `GET /api/cron/relay` | Scans for new burns, then drains anything still due. The safety net. |

The queue is two columns on `relay_jobs`: `next_attempt_at` (what used to be a BullMQ delay) and
`leased_until` (what makes two overlapping invocations safe). `claimDueJobs` takes rows with
`FOR UPDATE SKIP LOCKED`, so a cron tick racing an inline drain skips the other's rows instead of
minting the same message twice.

Both handlers call the same `processJob` as the container does. There is one implementation of the
part that moves money.

### Why the fast path is inline and not cron

Cron granularity is a plan feature. On **Pro** the minimum interval is once per minute; on
**Hobby** it is **once per day**, and a more frequent cron expression fails at deploy time. A
transfer cannot wait a day for its mint, so the mint is attempted inside the request that reports
the burn, and cron exists to catch what that could not finish — a function killed at its duration
limit, an attestation that was not ready yet, a Solana submission backing off after a failure.

That is why this works on either plan, and why Pro tightens the worst case rather than enabling
the feature.

`vercel.json` ships the Hobby-safe daily schedule. **On Pro, change it to `* * * * *`** — a
one-line edit, and the worst-case delay for a stalled transfer drops from a day to a minute.

## You will need Pro anyway

Not for the crons — for the terms. Vercel's fair-use guidelines restrict Hobby to
non-commercial, personal use. Charging a bridge fee is commercial, so a fee-taking deployment
belongs on Pro ($20/month). Hobby is fine while you are moving your own money to test.

## Setup

### 1. Database

Any Postgres works. Neon is the path of least resistance from the Vercel dashboard
(**Storage → Create → Neon**), and its free tier is enough to start.

Two things matter more than the provider:

- **Use the pooled connection string.** Serverless functions open a connection per invocation, and
  an unpooled Postgres will refuse connections under any real traffic. Neon and Supabase both give
  you a pooler endpoint; use that one.
- **Run the migrations.** `pnpm --filter @xebra/db migrate` with `DATABASE_URL` set. There are
  four, and the relay reads `relay_jobs` and `watcher_cursors` from the last two.

### 2. Environment variables

In the Vercel project, for the Production environment.

Public — these are inlined into the browser bundle at build time, so they must be set **before**
the build, not at runtime. Copy them from `.env.production`:

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

Secret — server-side only, never `NEXT_PUBLIC_*`:

| Variable | What it is |
|---|---|
| `DATABASE_URL` | Pooled Postgres connection string |
| `RELAY_SOLANA_KEYPAIR` | The hot wallet that pays for mints. Base58, base64 or a `solana-keygen` JSON array |
| `CRON_SECRET` | `openssl rand -base64 32`. Vercel sends it as a bearer token on cron requests; without it the cron route refuses to run |
| `RELAY_SUBMIT_TOKEN` | Optional. Bypasses the admission bounds, for re-driving an old burn by hand |
| `SOROBAN_START_LEDGER` | Required only once the wrapper is deployed — the ledger to start watching from |

Note what is *not* here: no `REDIS_URL`, no `KAFKA_BROKERS`. Nothing in the Vercel deployment uses
them.

### 3. Deploy

`vercel.json` builds only `apps/web` and the packages it depends on, so the monorepo's other
services are not built or deployed. They stay in the repo for anyone who wants to self-host the
container version.

### 4. Check it

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://<your-domain>/api/cron/relay
```

`{"status":"ok",...}` means the database is reachable and the relay is configured. `unconfigured`
means `DATABASE_URL` or `RELAY_SOLANA_KEYPAIR` is missing.

## The relay's exposure, stated plainly

Every mint costs the hot wallet 867,621 lamports of permanent rent plus fees, and up to 2,039,280
more if the recipient has no USDC account yet. None of it is recoverable.

Until the wrapper contract is deployed there is nothing on chain that distinguishes a burn made
through this app from any other CCTP user's burn on Stellar — Circle's contract serves everyone.
So `/api/relay/burns` cannot tell whose burn it is being asked to pay for. It is bounded rather
than authenticated:

- a burn older than an hour is refused, so nobody can dump a backlog into the queue;
- sponsorship stops after 200 mints in 24 hours, which caps the loss.

A determined griefer inside those bounds can still get a bounded number of their own transfers
sponsored. **Deploying the wrapper is what actually removes this**, because then the watcher only
ever sees burns we were paid a fee on. It is on the launch path in `docs/go-live.md` for revenue
reasons; this is the second reason.

Refusing to sponsor never strands anyone. The burn stays claimable by whoever holds Circle's
attestation, which is public and never expires.

## What is still missing

- **The in-browser claim page.** If the relay is unavailable the receipt tells the user to keep
  their hash. The funds are safe, but "someone else runs a script for you" is not self-serve.
- **Alerting.** The metrics exist; nothing pages anyone. The one that matters most is the hot
  wallet running low, because that stalls every transfer at once.

## Three build details worth knowing

**`build:vercel` exists because of the dist directory.** Locally, `pnpm build` writes to
`.next-build` rather than `.next`, so a production build cannot wipe the directory a running
`next dev` is serving from — when it does, every request fails with `ENOENT:
routes-manifest.json`, the build looks fine, the dev server looks broken, and nothing in either
message points at the other process. On Vercel there is no dev server to protect and Vercel
expects `.next`, so the hosted script omits the override.

**`.env.production` is not in the repo**, deliberately — a `.env` in git reads as a mistake
whatever it contains. `scripts/with-env.mjs` therefore treats a missing file as "use the
environment" when `NETWORK` or `NEXT_PUBLIC_NETWORK` is already set, and still fails loudly on a
local checkout where neither is. That is why the Vercel variables must include
`NEXT_PUBLIC_NETWORK`.

**`--filter @xebra/web^...`** builds only the workspace packages `apps/web` depends on —
including `@xebra/relay-core` and `@xebra/cctp-solana`, which the route handlers import. The
other services are not built.
