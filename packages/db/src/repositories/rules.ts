import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { DesignRule } from "@embedded/core";
import type { Db } from "../client.js";
import { designRules } from "../schema.js";

function rowToDesignRule(row: typeof designRules.$inferSelect): DesignRule {
  return DesignRule.parse({
    ...row,
    appliesTo: typeof row.appliesTo === "string" ? JSON.parse(row.appliesTo) : row.appliesTo,
    check: typeof row.check === "string" ? JSON.parse(row.check) : row.check,
    // DB column is nullable text; core schema wants `undefined` (optional), not `null`.
    citation: row.citation ?? undefined,
  });
}

export function createRulesRepo(db: Db) {
  return {
    list(): DesignRule[] {
      return db.select().from(designRules).all().map(rowToDesignRule);
    },

    listEnabled(): DesignRule[] {
      return db
        .select()
        .from(designRules)
        .where(eq(designRules.enabled, true))
        .all()
        .map(rowToDesignRule);
    },

    get(id: string): DesignRule | undefined {
      const row = db.select().from(designRules).where(eq(designRules.id, id)).get();
      return row ? rowToDesignRule(row) : undefined;
    },

    create(input: DesignRule): DesignRule {
      const parsed = DesignRule.parse(input);
      const now = new Date().toISOString();
      const row: typeof designRules.$inferInsert = {
        id: nanoid(),
        name: parsed.name,
        description: parsed.description,
        severity: parsed.severity,
        appliesTo: parsed.appliesTo,
        check: parsed.check,
        citation: parsed.citation ?? null,
        enabled: parsed.enabled,
        builtin: parsed.builtin,
        createdAt: now,
        updatedAt: now,
      };
      db.insert(designRules).values(row).run();
      return rowToDesignRule(row as typeof designRules.$inferSelect);
    },

    update(id: string, input: Partial<DesignRule>): DesignRule | undefined {
      const existing = db.select().from(designRules).where(eq(designRules.id, id)).get();
      if (!existing) return undefined;

      const patch: Partial<typeof designRules.$inferInsert> = {
        updatedAt: new Date().toISOString(),
      };
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.severity !== undefined) patch.severity = input.severity;
      if (input.appliesTo !== undefined) patch.appliesTo = input.appliesTo;
      if (input.check !== undefined) patch.check = input.check;
      if (input.citation !== undefined) patch.citation = input.citation ?? null;
      if (input.enabled !== undefined) patch.enabled = input.enabled;

      db.update(designRules).set(patch).where(eq(designRules.id, id)).run();
      const row = db.select().from(designRules).where(eq(designRules.id, id)).get();
      return row ? rowToDesignRule(row) : undefined;
    },

    delete(id: string): void {
      db.delete(designRules).where(eq(designRules.id, id)).run();
    },

    /**
     * Insert a shipped rule if it isn't already present.
     *
     * Deliberately insert-only: seeds are the app's starting knowledge, but
     * once a row exists it belongs to the user. Upserting on every boot would
     * silently revert their edits, which breaks the whole "the library is
     * yours, and it's data" premise. Returns true when a row was created.
     */
    seed(rule: DesignRule): boolean {
      const existing = db
        .select()
        .from(designRules)
        .where(eq(designRules.id, rule.id))
        .get();
      if (existing) return false;
      db.insert(designRules)
        .values({
          id: rule.id,
          name: rule.name,
          description: rule.description,
          severity: rule.severity,
          appliesTo: rule.appliesTo,
          check: rule.check,
          citation: rule.citation ?? null,
          enabled: rule.enabled,
          builtin: rule.builtin,
          createdAt: rule.createdAt,
          updatedAt: rule.updatedAt,
        })
        .run();
      return true;
    },
  };
}
