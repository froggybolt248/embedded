import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { databasePath } from "./paths.js";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof createDb>;

export function createDb(path: string = databasePath()) {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

/** Apply committed SQL migrations (idempotent, runs at server startup). */
export function migrateDb(db: Db) {
  const migrationsFolder = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  migrate(db, { migrationsFolder });
}
