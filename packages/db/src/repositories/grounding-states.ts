import { eq } from "drizzle-orm";
import type { Db } from "../client.js";
import { groundingStates } from "../schema.js";

/**
 * Persisted grounding state for a component. Kept as plain strings (not the
 * `GroundingStatus` union) because that type lives in
 * apps/server/src/services/deepen.ts, which this package must not depend on —
 * the server owns the vocabulary, the db package just stores it.
 */
export interface GroundingStateRow {
  componentId: string;
  status: string;
  detail: string | null;
  error: string | null;
  updatedAt: string;
}

export interface UpsertGroundingStateInput {
  status: string;
  detail: string | null;
  error: string | null;
  updatedAt: string;
}

function rowToGroundingState(row: typeof groundingStates.$inferSelect): GroundingStateRow {
  return {
    componentId: row.componentId,
    status: row.status,
    detail: row.detail,
    error: row.error,
    updatedAt: row.updatedAt,
  };
}

export function createGroundingStatesRepo(db: Db) {
  return {
    get(componentId: string): GroundingStateRow | undefined {
      const row = db
        .select()
        .from(groundingStates)
        .where(eq(groundingStates.componentId, componentId))
        .get();
      return row ? rowToGroundingState(row) : undefined;
    },

    /** Insert or overwrite the state for a component — restarts must see the LAST known state. */
    upsert(componentId: string, input: UpsertGroundingStateInput): GroundingStateRow {
      const row: typeof groundingStates.$inferInsert = {
        componentId,
        status: input.status,
        detail: input.detail,
        error: input.error,
        updatedAt: input.updatedAt,
      };
      const existing = db
        .select()
        .from(groundingStates)
        .where(eq(groundingStates.componentId, componentId))
        .get();
      if (existing) {
        db.update(groundingStates)
          .set({ status: row.status, detail: row.detail, error: row.error, updatedAt: row.updatedAt })
          .where(eq(groundingStates.componentId, componentId))
          .run();
      } else {
        db.insert(groundingStates).values(row).run();
      }
      return rowToGroundingState(row as typeof groundingStates.$inferSelect);
    },
  };
}
