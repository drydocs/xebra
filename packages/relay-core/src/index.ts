/**
 * @xebra/relay-core — everything the CCTP relay does, with no opinion about how it is hosted.
 *
 * # Why this is a package and not an app
 *
 * The relay was written as a long-running process: a BullMQ worker on Redis, a watcher loop, a
 * container. That shape needs somewhere to run a container, which this project does not have —
 * the deployment target is Vercel, where there is no long-lived process and no Redis.
 *
 * So the pipeline lives here, driven by whichever caller is available: `drainDueJobs` for a
 * cron-invoked serverless function (`apps/web`), or the BullMQ worker in `apps/cctp-relay` for
 * anyone self-hosting. Both call the same `processJob`, the same state machine and the same
 * store, so there is one implementation of the part that moves money.
 *
 * Nothing here opens a listener, reads an env var or picks a schedule. Callers do that.
 *
 * The Postgres implementations live behind `@xebra/relay-core/postgres` rather than here, so a
 * caller storing state elsewhere — Convex, in the deployed app — does not pull Drizzle and the
 * Postgres driver into its bundle to get at the pipeline.
 */

export * from "./admission.js";
export * from "./auth.js";
export * from "./burn-watcher.js";
export * from "./drain.js";
export * from "./job-store.js";
export * from "./process-job.js";
export * from "./schedule.js";
export * from "./soroban-burn-source.js";
