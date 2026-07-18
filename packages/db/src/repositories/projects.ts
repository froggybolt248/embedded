import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Project, CreateProjectInput, UpdateProjectInput } from "@embedded/core";
import type { Db } from "../client.js";
import { projects } from "../schema.js";

function rowToProject(row: typeof projects.$inferSelect): Project {
  return Project.parse({
    ...row,
    phaseStates:
      typeof row.phaseStates === "string" ? JSON.parse(row.phaseStates) : row.phaseStates,
  });
}

export function createProjectsRepo(db: Db) {
  return {
    list(): Project[] {
      return db.select().from(projects).all().map(rowToProject);
    },

    get(id: string): Project | undefined {
      const row = db.select().from(projects).where(eq(projects.id, id)).get();
      return row ? rowToProject(row) : undefined;
    },

    create(input: CreateProjectInput): Project {
      const parsed = CreateProjectInput.parse(input);
      const now = new Date().toISOString();
      const row: typeof projects.$inferInsert = {
        id: nanoid(),
        name: parsed.name,
        description: parsed.description ?? "",
        archetypeId: parsed.archetypeId ?? null,
        phaseStates: {},
        createdAt: now,
        updatedAt: now,
      };
      db.insert(projects).values(row).run();
      return rowToProject(row as typeof projects.$inferSelect);
    },

    update(id: string, input: UpdateProjectInput): Project | undefined {
      const parsed = UpdateProjectInput.parse(input);
      const existing = db.select().from(projects).where(eq(projects.id, id)).get();
      if (!existing) return undefined;

      db.update(projects)
        .set({ name: parsed.name, updatedAt: new Date().toISOString() })
        .where(eq(projects.id, id))
        .run();
      const row = db.select().from(projects).where(eq(projects.id, id)).get();
      return row ? rowToProject(row) : undefined;
    },

    remove(id: string): void {
      db.delete(projects).where(eq(projects.id, id)).run();
    },
  };
}
