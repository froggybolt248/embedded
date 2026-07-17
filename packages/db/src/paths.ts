import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

/**
 * All runtime data (DB, ingested datasheet PDFs, page renders) lives under
 * the per-user app data dir, never inside the repo.
 */
export function appDataDir(): string {
  const base =
    process.env["EMBEDDED_DATA_DIR"] ??
    (process.platform === "win32"
      ? join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "embedded")
      : join(homedir(), ".local", "share", "embedded"));
  mkdirSync(base, { recursive: true });
  return base;
}

export function databasePath(): string {
  return join(appDataDir(), "embedded.db");
}

export function datasheetsDir(): string {
  const dir = join(appDataDir(), "library", "datasheets");
  mkdirSync(dir, { recursive: true });
  return dir;
}
