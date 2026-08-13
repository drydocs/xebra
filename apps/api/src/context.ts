import type * as trpcStandalone from "@trpc/server/adapters/standalone";
import { type Database, createDb } from "@xebra/db";

export interface Context {
  db: Database;
}

export function createContextFactory(db: Database) {
  return function createContext(_opts: trpcStandalone.CreateHTTPContextOptions): Context {
    return { db };
  };
}

export function createDbFromEnv(): Database {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  return createDb(connectionString);
}
