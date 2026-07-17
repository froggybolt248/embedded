import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Same isolation seam as app.test.ts — EMBEDDED_DATA_DIR must be set before
// @embedded/db resolves the sqlite path, so this runs before importing app.js.
const dataDir = mkdtempSync(join(tmpdir(), "embedded-family-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

/**
 * Exercises the family columns against a REAL migrated database, because
 * migration 0002 is not purely generated: drizzle-kit emitted the family_id
 * ALTER without its `ON DELETE set null` clause and the clause was added by
 * hand. Since the client runs with `foreign_keys = ON`, getting that wrong
 * fails loudly here — deleting a family would raise a constraint error instead
 * of orphaning its variants cleanly.
 */
describe("component family persistence", () => {
  let app: FastifyInstance;

  const create = async (body: Record<string, unknown>) => {
    const res = await app.inject({ method: "POST", url: "/api/components", payload: body });
    expect(res.statusCode).toBeLessThan(300);
    return res.json() as { id: string; familyId: string | null };
  };

  const get = async (id: string) => {
    const res = await app.inject({ method: "GET", url: `/api/components/${id}` });
    return res.json() as {
      familyId: string | null;
      isFamily: boolean;
      orderingCode?: string;
      variantAttrs: Record<string, string>;
    };
  };

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("defaults an ordinary component to standalone", async () => {
    const created = await create({ mpn: "BME280" });
    const row = await get(created.id);
    expect(row.familyId).toBeNull();
    expect(row.isFamily).toBe(false);
    expect(row.variantAttrs).toEqual({});
    expect(row.orderingCode).toBeUndefined();
  });

  it("round-trips a family and its variant through sqlite", async () => {
    const family = await create({ mpn: "STM32F103x8/xB", isFamily: true });
    const variant = await create({
      mpn: "STM32F103C8T6",
      familyId: family.id,
      orderingCode: "STM32F103C8T6",
      variantAttrs: { flash: "64 KB", package: "LQFP48" },
    });

    const row = await get(variant.id);
    expect(row.familyId).toBe(family.id);
    expect(row.orderingCode).toBe("STM32F103C8T6");
    expect(row.variantAttrs).toEqual({ flash: "64 KB", package: "LQFP48" });
    expect((await get(family.id)).isFamily).toBe(true);
  });

  it("nulls a variant's familyId when its family is deleted, rather than erroring", async () => {
    const family = await create({ mpn: "ATmega328-FAM", isFamily: true });
    const variant = await create({ mpn: "ATmega328P-PU", familyId: family.id });

    const del = await app.inject({ method: "DELETE", url: `/api/components/${family.id}` });
    expect(del.statusCode).toBeLessThan(300);

    // the variant survives as a standalone part — this is the ON DELETE set null
    // clause that drizzle-kit dropped from the generated ALTER
    const row = await get(variant.id);
    expect(row.familyId).toBeNull();
  });
});
