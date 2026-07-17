import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Block, CreateBlockInput, UpdateBlockInput } from "@embedded/core";
import type { Db } from "../client.js";
import { blocks } from "../schema.js";

function rowToBlock(row: typeof blocks.$inferSelect): Block {
  return Block.parse({
    ...row,
    duties: typeof row.duties === "string" ? JSON.parse(row.duties) : row.duties,
  });
}

export function createBlocksRepo(db: Db) {
  return {
    listByProject(projectId: string): Block[] {
      return db.select().from(blocks).where(eq(blocks.projectId, projectId)).all().map(rowToBlock);
    },

    get(id: string): Block | undefined {
      const row = db.select().from(blocks).where(eq(blocks.id, id)).get();
      return row ? rowToBlock(row) : undefined;
    },

    create(projectId: string, input: CreateBlockInput): Block {
      const parsed = CreateBlockInput.parse(input);
      const row: typeof blocks.$inferInsert = {
        id: nanoid(),
        projectId,
        name: parsed.name,
        role: parsed.role ?? "other",
        componentId: parsed.componentId ?? null,
        notes: parsed.notes ?? "",
        x: parsed.x ?? 0,
        y: parsed.y ?? 0,
        duties: parsed.duties ?? {},
      };
      db.insert(blocks).values(row).run();
      return rowToBlock(row as typeof blocks.$inferSelect);
    },

    update(id: string, input: UpdateBlockInput): Block | undefined {
      const parsed = UpdateBlockInput.parse(input);
      const existing = db.select().from(blocks).where(eq(blocks.id, id)).get();
      if (!existing) return undefined;

      const patch: Partial<typeof blocks.$inferInsert> = {};
      if (parsed.name !== undefined) patch.name = parsed.name;
      if (parsed.role !== undefined) patch.role = parsed.role;
      if (parsed.componentId !== undefined) patch.componentId = parsed.componentId;
      if (parsed.notes !== undefined) patch.notes = parsed.notes;
      if (parsed.x !== undefined) patch.x = parsed.x;
      if (parsed.y !== undefined) patch.y = parsed.y;
      if (parsed.duties !== undefined) patch.duties = parsed.duties;

      if (Object.keys(patch).length > 0) {
        db.update(blocks).set(patch).where(eq(blocks.id, id)).run();
      }
      const row = db.select().from(blocks).where(eq(blocks.id, id)).get();
      return row ? rowToBlock(row) : undefined;
    },

    remove(id: string): void {
      db.delete(blocks).where(eq(blocks.id, id)).run();
    },
  };
}
