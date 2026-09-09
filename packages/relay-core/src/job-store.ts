import type { RelayJobState } from "@xebra/cctp-client";

/**
 * Persistence boundary for relay job state. Kept as an interface here rather than importing a
 * concrete Postgres/Drizzle implementation: `packages/db`'s schema (docs/architecture.md §10's
 * `relay_jobs` table) lands in the backend-services phase, after this service's own logic. Any
 * store satisfying this interface — Postgres in production, an in-memory Map in tests — works.
 */
export interface RelayJobStore {
  save(job: RelayJobState): Promise<void>;
  get(id: string): Promise<RelayJobState | undefined>;
}

export class InMemoryRelayJobStore implements RelayJobStore {
  private readonly jobs = new Map<string, RelayJobState>();

  async save(job: RelayJobState): Promise<void> {
    this.jobs.set(job.id, job);
  }

  async get(id: string): Promise<RelayJobState | undefined> {
    return this.jobs.get(id);
  }
}
