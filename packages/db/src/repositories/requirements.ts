import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Requirement, CreateRequirementInput, UpdateRequirementInput } from "@embedded/core";
import type { Db } from "../client.js";
import { requirements } from "../schema.js";

function rowToRequirement(row: typeof requirements.$inferSelect): Requirement {
  return Requirement.parse({
    ...row,
    quantified:
      typeof row.quantified === "string" ? JSON.parse(row.quantified) : row.quantified,
  });
}

export function createRequirementsRepo(db: Db) {
  return {
    listByProject(projectId: string): Requirement[] {
      return db
        .select()
        .from(requirements)
        .where(eq(requirements.projectId, projectId))
        .all()
        .map(rowToRequirement);
    },

    get(id: string): Requirement | undefined {
      const row = db.select().from(requirements).where(eq(requirements.id, id)).get();
      return row ? rowToRequirement(row) : undefined;
    },

    create(projectId: string, input: CreateRequirementInput): Requirement {
      const parsed = CreateRequirementInput.parse(input);
      const row: typeof requirements.$inferInsert = {
        id: nanoid(),
        projectId,
        kind: parsed.kind ?? "functional",
        text: parsed.text,
        quantified: parsed.quantified ?? null,
        status: parsed.status ?? "open",
        createdAt: new Date().toISOString(),
      };
      db.insert(requirements).values(row).run();
      return rowToRequirement(row as typeof requirements.$inferSelect);
    },

    update(id: string, input: UpdateRequirementInput): Requirement | undefined {
      const parsed = UpdateRequirementInput.parse(input);
      const existing = db.select().from(requirements).where(eq(requirements.id, id)).get();
      if (!existing) return undefined;

      const patch: Partial<typeof requirements.$inferInsert> = {};
      if (parsed.kind !== undefined) patch.kind = parsed.kind;
      if (parsed.text !== undefined) patch.text = parsed.text;
      if (parsed.quantified !== undefined) patch.quantified = parsed.quantified;
      if (parsed.status !== undefined) patch.status = parsed.status;

      if (Object.keys(patch).length > 0) {
        db.update(requirements).set(patch).where(eq(requirements.id, id)).run();
      }
      const row = db.select().from(requirements).where(eq(requirements.id, id)).get();
      return row ? rowToRequirement(row) : undefined;
    },

    remove(id: string): void {
      db.delete(requirements).where(eq(requirements.id, id)).run();
    },
  };
}
