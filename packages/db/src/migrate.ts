import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "./client.js";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error("DATABASE_URL is required");
  }
  const db = createDb(connectionString);
  await migrate(db, { migrationsFolder: "./drizzle" });
  console.log("migrations applied");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
