import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Archetype, DesignRule } from "@embedded/core";
import { createArchetypesRepo, createRulesRepo, type Db } from "@embedded/db";

/**
 * Load the shipped archetypes into the library on boot.
 *
 * Archetypes are the app's answer to "what am I even building?" — without them
 * a new project is an empty canvas and a 22k-part search box, which asks the
 * designer to already know the answer. They are ordinary DB rows, not code, so
 * the user can edit or add their own and a future in-app agent can write more.
 * Seeding is insert-only (see `seed`), so this is safe to run every boot.
 */

const SEEDS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "seeds");

export function seedArchetypes(db: Db, seedsDir = SEEDS_DIR): number {
  const repo = createArchetypesRepo(db);
  const file = join(seedsDir, "archetypes.json");

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // A packaged build without the seeds dir must still boot — an empty
    // archetype list is a worse experience, not a broken one.
    return 0;
  }

  const now = new Date().toISOString();
  const parsed = parseSeeds(raw, now);
  let created = 0;
  for (const archetype of parsed) {
    if (repo.seed(archetype)) created++;
  }
  return created;
}

function parseSeeds(raw: string, now: string): Archetype[] {
  const rows = JSON.parse(raw) as unknown[];
  return rows.map((row) =>
    Archetype.parse({ ...(row as object), createdAt: now, updatedAt: now }),
  );
}

export function seedRules(db: Db, seedsDir = SEEDS_DIR): number {
  const repo = createRulesRepo(db);
  const file = join(seedsDir, "rules.json");

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    // A packaged build without the seeds dir must still boot — an empty
    // rules list is a worse experience, not a broken one.
    return 0;
  }

  const now = new Date().toISOString();
  const parsed = parseRuleSeeds(raw, now);
  let created = 0;
  for (const rule of parsed) {
    if (repo.seed(rule)) created++;
  }
  return created;
}

function parseRuleSeeds(raw: string, now: string): DesignRule[] {
  const rows = JSON.parse(raw) as unknown[];
  return rows.map((row) =>
    DesignRule.parse({ ...(row as object), createdAt: now, updatedAt: now }),
  );
}
