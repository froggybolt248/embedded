import { and, eq, inArray, like, or, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import {
  Component,
  ComponentCategory,
  ComponentSpecs,
  CreateComponentInput,
  UpdateComponentInput,
} from "@embedded/core";
import type { Db } from "../client.js";
import { components } from "../schema.js";

function rowToComponent(row: typeof components.$inferSelect): Component {
  return Component.parse({
    ...row,
    specs: typeof row.specs === "string" ? JSON.parse(row.specs) : row.specs,
    variantAttrs:
      typeof row.variantAttrs === "string" ? JSON.parse(row.variantAttrs) : row.variantAttrs,
    // DB column is nullable text; core schema wants `undefined` (optional), not `null`.
    orderingCode: row.orderingCode ?? undefined,
  });
}

function buildWhere(filter: ListComponentsFilter): SQL | undefined {
  const clauses: SQL[] = [];
  if (filter.q) {
    const pattern = `%${filter.q}%`;
    const search = or(
      like(components.mpn, pattern),
      like(components.manufacturer, pattern),
      like(components.description, pattern),
    );
    if (search) clauses.push(search);
  }
  if (filter.category) clauses.push(eq(components.category, filter.category));
  if (filter.familyId) clauses.push(eq(components.familyId, filter.familyId));
  if (filter.mpns) clauses.push(inArray(components.mpn, filter.mpns));
  return clauses.length > 0 ? and(...clauses) : undefined;
}

export interface ListComponentsFilter {
  /** matches mpn, manufacturer, or description (case-insensitive substring) */
  q?: string | undefined;
  category?: ComponentCategory | undefined;
  /** only variants of this family id */
  familyId?: string | undefined;
  /** exact MPN match — resolves an archetype's preferred picks in one query */
  mpns?: string[] | undefined;
  /** page size — the library can hold tens of thousands of parts after a bulk import */
  limit?: number | undefined;
  offset?: number | undefined;
}

export interface LibraryStats {
  total: number;
  byCategory: Record<string, number>;
}

export function createComponentsRepo(db: Db) {
  return {
    list(filter: ListComponentsFilter = {}): Component[] {
      const where = buildWhere(filter);
      let query = db.select().from(components).$dynamic();
      if (where) query = query.where(where);
      if (filter.limit !== undefined) query = query.limit(filter.limit);
      if (filter.offset !== undefined) query = query.offset(filter.offset);
      return query.all().map(rowToComponent);
    },

    /**
     * Library composition — total plus a per-category breakdown, computed in
     * SQL rather than by listing rows, so the browser's faceted counts stay
     * cheap even with tens of thousands of parts.
     */
    stats(): LibraryStats {
      const rows = db
        .select({ category: components.category, n: sql<number>`count(*)`.as("n") })
        .from(components)
        .groupBy(components.category)
        .all();
      const byCategory: Record<string, number> = {};
      let total = 0;
      for (const row of rows) {
        byCategory[row.category] = Number(row.n);
        total += Number(row.n);
      }
      return { total, byCategory };
    },

    /** Just the MPNs — a light dedupe key for bulk import, no JSON parsing. */
    allMpns(): string[] {
      return db.select({ mpn: components.mpn }).from(components).all().map((r) => r.mpn);
    },

    get(id: string): Component | undefined {
      const row = db.select().from(components).where(eq(components.id, id)).get();
      return row ? rowToComponent(row) : undefined;
    },

    create(input: CreateComponentInput): Component {
      const parsed = CreateComponentInput.parse(input);
      const now = new Date().toISOString();
      const row: typeof components.$inferInsert = {
        id: nanoid(),
        mpn: parsed.mpn,
        manufacturer: parsed.manufacturer ?? "",
        description: parsed.description ?? "",
        category: parsed.category ?? "other",
        lifecycle: parsed.lifecycle ?? "unknown",
        specs: ComponentSpecs.parse(parsed.specs ?? {}),
        familyId: parsed.familyId ?? null,
        isFamily: parsed.isFamily ?? false,
        ...(parsed.orderingCode !== undefined ? { orderingCode: parsed.orderingCode } : {}),
        variantAttrs: parsed.variantAttrs ?? {},
        createdAt: now,
        updatedAt: now,
      };
      db.insert(components).values(row).run();
      return rowToComponent(row as typeof components.$inferSelect);
    },

    update(id: string, input: UpdateComponentInput): Component | undefined {
      const parsed = UpdateComponentInput.parse(input);
      const existing = db.select().from(components).where(eq(components.id, id)).get();
      if (!existing) return undefined;

      const patch: Partial<typeof components.$inferInsert> = {
        updatedAt: new Date().toISOString(),
      };
      if (parsed.mpn !== undefined) patch.mpn = parsed.mpn;
      if (parsed.manufacturer !== undefined) patch.manufacturer = parsed.manufacturer;
      if (parsed.description !== undefined) patch.description = parsed.description;
      if (parsed.category !== undefined) patch.category = parsed.category;
      if (parsed.lifecycle !== undefined) patch.lifecycle = parsed.lifecycle;
      if (parsed.specs !== undefined) patch.specs = ComponentSpecs.parse(parsed.specs);
      if (parsed.familyId !== undefined) patch.familyId = parsed.familyId;
      if (parsed.isFamily !== undefined) patch.isFamily = parsed.isFamily;
      if (parsed.orderingCode !== undefined) patch.orderingCode = parsed.orderingCode;
      if (parsed.variantAttrs !== undefined) patch.variantAttrs = parsed.variantAttrs;

      db.update(components).set(patch).where(eq(components.id, id)).run();
      const row = db.select().from(components).where(eq(components.id, id)).get();
      return row ? rowToComponent(row) : undefined;
    },

    remove(id: string): void {
      db.delete(components).where(eq(components.id, id)).run();
    },
  };
}
