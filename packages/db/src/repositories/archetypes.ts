import { eq } from "drizzle-orm";
import { Archetype } from "@embedded/core";
import type { Db } from "../client.js";
import { archetypes } from "../schema.js";

function rowToArchetype(row: typeof archetypes.$inferSelect): Archetype {
  return Archetype.parse({
    ...row,
    recipe: typeof row.recipe === "string" ? JSON.parse(row.recipe) : row.recipe,
  });
}

export function createArchetypesRepo(db: Db) {
  return {
    list(): Archetype[] {
      return db.select().from(archetypes).all().map(rowToArchetype);
    },

    get(id: string): Archetype | undefined {
      const row = db.select().from(archetypes).where(eq(archetypes.id, id)).get();
      return row ? rowToArchetype(row) : undefined;
    },

    /**
     * Insert a shipped archetype if it isn't already present.
     *
     * Deliberately insert-only: seeds are the app's starting knowledge, but
     * once a row exists it belongs to the user. Upserting on every boot would
     * silently revert their edits, which breaks the whole "the library is
     * yours, and it's data" premise. Returns true when a row was created.
     */
    seed(input: Archetype): boolean {
      const existing = db.select().from(archetypes).where(eq(archetypes.id, input.id)).get();
      if (existing) return false;
      db.insert(archetypes)
        .values({
          id: input.id,
          name: input.name,
          description: input.description,
          recipe: input.recipe,
          createdAt: input.createdAt,
          updatedAt: input.updatedAt,
        })
        .run();
      return true;
    },
  };
}
