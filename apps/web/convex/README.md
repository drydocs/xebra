# convex/

One table: the counter that keeps our calls to Circle's Iris API under its rate limit.

There used to be a relay here (jobs, retries, a burn watcher, a hot wallet). It is gone. Circle's
Forwarding Service mints on the destination, and a transfer whose forward fails is claimed by its
owner at `/claim`. Nothing in this directory holds a key, funds or anyone's transfer.

## Before anything typechecks here

`_generated/` is checked in, but Convex regenerates it from `schema.ts` and the function
signatures against your own deployment:

```bash
cd apps/web
npx convex dev        # first run: logs in, creates the project, rewrites _generated/
```

`apps/web/tsconfig.json` excludes this directory: the Next.js build must not depend on files a
contributor has not generated. The Next.js routes reach these functions by name through
`makeFunctionReference` (see `lib/server/iris.ts`), which needs no codegen.

## What is public

`irisBudget.acquire`, `irisBudget.rateLimited` and `irisBudget.current`. They are public because the
Next.js server calls them over HTTP, and each takes `secret`, checked against `IRIS_BUDGET_SECRET`
on this deployment. Unguarded, anyone could call `rateLimited` and blind our delivery status and
health check for five and a half minutes. None of it moves money. An unset secret refuses
everything.

## Bundling

`irisBudget.ts` imports `@xebra/cctp-client`, a `workspace:*` package that does not exist on npm, so
Convex bundles it inline from `dist/`. **Build it before `npx convex dev` or `npx convex deploy`:**

```bash
pnpm --filter @xebra/cctp-client build
```

## Environment variables

Set on the Convex deployment (`npx convex env set NAME value`) **and** in the web app's server
environment:

| | |
|---|---|
| `IRIS_BUDGET_SECRET` | Required, the same value in both places. Any long random string |

The web app also reads `CONVEX_URL` (or `NEXT_PUBLIC_CONVEX_URL`). If either is missing, the app
counts Iris calls per instance instead of shared, and logs it once.

## Removing the old relay tables

The deployment created for the relay has `relayJobs` and `watcherCursors` tables. Convex will not
deploy a schema that omits a table which still holds documents, so clear them first (dashboard →
Data → each table → delete all), then `npx convex deploy`. They hold public transaction hashes and
Circle's public attestations; nothing in them is secret or unrecoverable.
