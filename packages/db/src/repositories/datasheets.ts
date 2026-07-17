import { desc, eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Datasheet, ExtractionRun } from "@embedded/core";
import type { Db } from "../client.js";
import { datasheets, extractionRuns } from "../schema.js";

function rowToDatasheet(row: typeof datasheets.$inferSelect): Datasheet {
  return Datasheet.parse(row);
}

function rowToExtractionRun(row: typeof extractionRuns.$inferSelect): ExtractionRun {
  return ExtractionRun.parse({
    ...row,
    sectionMap:
      typeof row.sectionMap === "string" ? JSON.parse(row.sectionMap) : row.sectionMap,
    fields: typeof row.fields === "string" ? JSON.parse(row.fields) : row.fields,
    error: row.error ?? undefined,
  });
}

export interface CreateDatasheetInput {
  componentId?: string | null | undefined;
  filename: string;
  filePath: string;
  sha256: string;
  pageCount: number;
}

export function createDatasheetsRepo(db: Db) {
  return {
    list(): Datasheet[] {
      return db.select().from(datasheets).all().map(rowToDatasheet);
    },

    get(id: string): Datasheet | undefined {
      const row = db.select().from(datasheets).where(eq(datasheets.id, id)).get();
      return row ? rowToDatasheet(row) : undefined;
    },

    findBySha(sha256: string): Datasheet | undefined {
      const row = db.select().from(datasheets).where(eq(datasheets.sha256, sha256)).get();
      return row ? rowToDatasheet(row) : undefined;
    },

    /** The most recent datasheet linked to a component, if it has one. */
    findByComponent(componentId: string): Datasheet | undefined {
      const row = db
        .select()
        .from(datasheets)
        .where(eq(datasheets.componentId, componentId))
        .orderBy(desc(datasheets.createdAt))
        .get();
      return row ? rowToDatasheet(row) : undefined;
    },

    create(input: CreateDatasheetInput): Datasheet {
      const row: typeof datasheets.$inferInsert = {
        id: nanoid(),
        componentId: input.componentId ?? null,
        filename: input.filename,
        filePath: input.filePath,
        sha256: input.sha256,
        pageCount: input.pageCount,
        createdAt: new Date().toISOString(),
      };
      db.insert(datasheets).values(row).run();
      return rowToDatasheet(row as typeof datasheets.$inferSelect);
    },

    linkComponent(id: string, componentId: string | null): Datasheet | undefined {
      db.update(datasheets).set({ componentId }).where(eq(datasheets.id, id)).run();
      const row = db.select().from(datasheets).where(eq(datasheets.id, id)).get();
      return row ? rowToDatasheet(row) : undefined;
    },

    remove(id: string): void {
      db.delete(datasheets).where(eq(datasheets.id, id)).run();
    },
  };
}

export interface CreateExtractionRunInput {
  datasheetId: string;
  model: string;
  promptVersion: string;
}

export interface UpdateExtractionRunPatch {
  status?: ExtractionRun["status"] | undefined;
  sectionMap?: ExtractionRun["sectionMap"] | undefined;
  fields?: Record<string, unknown> | undefined;
  error?: string | undefined;
}

export function createExtractionRunsRepo(db: Db) {
  return {
    create(input: CreateExtractionRunInput): ExtractionRun {
      const row: typeof extractionRuns.$inferInsert = {
        id: nanoid(),
        datasheetId: input.datasheetId,
        model: input.model,
        promptVersion: input.promptVersion,
        status: "running",
        sectionMap: {},
        fields: {},
        error: null,
        createdAt: new Date().toISOString(),
      };
      db.insert(extractionRuns).values(row).run();
      return rowToExtractionRun(row as typeof extractionRuns.$inferSelect);
    },

    get(id: string): ExtractionRun | undefined {
      const row = db.select().from(extractionRuns).where(eq(extractionRuns.id, id)).get();
      return row ? rowToExtractionRun(row) : undefined;
    },

    listByDatasheet(datasheetId: string): ExtractionRun[] {
      return db
        .select()
        .from(extractionRuns)
        .where(eq(extractionRuns.datasheetId, datasheetId))
        .orderBy(desc(extractionRuns.createdAt))
        .all()
        .map(rowToExtractionRun);
    },

    update(id: string, patch: UpdateExtractionRunPatch): ExtractionRun | undefined {
      const set: Partial<typeof extractionRuns.$inferInsert> = {};
      if (patch.status !== undefined) set.status = patch.status;
      if (patch.sectionMap !== undefined) set.sectionMap = patch.sectionMap;
      if (patch.fields !== undefined) set.fields = patch.fields;
      if (patch.error !== undefined) set.error = patch.error;
      if (Object.keys(set).length > 0) {
        db.update(extractionRuns).set(set).where(eq(extractionRuns.id, id)).run();
      }
      const row = db.select().from(extractionRuns).where(eq(extractionRuns.id, id)).get();
      return row ? rowToExtractionRun(row) : undefined;
    },
  };
}
