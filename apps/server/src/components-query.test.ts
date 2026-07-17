import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const dataDir = mkdtempSync(join(tmpdir(), "embedded-cq-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

/** Exercises the scale features added for the bulk KiCad import: SQL-computed
 * faceted stats, pagination, and the family-variant filter. */
describe("component query endpoints", () => {
  let app: FastifyInstance;

  const create = async (body: Record<string, unknown>) => {
    const res = await app.inject({ method: "POST", url: "/api/components", payload: body });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  };

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    const family = await create({ mpn: "STM32F103x8", category: "mcu", isFamily: true });
    await create({ mpn: "STM32F103C8T6", category: "mcu", familyId: family.id });
    await create({ mpn: "STM32F103CBT6", category: "mcu", familyId: family.id });
    await create({ mpn: "BME280", category: "sensor" });
    await create({ mpn: "BMP280", category: "sensor" });
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("reports faceted stats", async () => {
    const res = await app.inject({ method: "GET", url: "/api/components/stats" });
    expect(res.statusCode).toBe(200);
    const stats = res.json() as { total: number; byCategory: Record<string, number> };
    expect(stats.total).toBe(5);
    expect(stats.byCategory["mcu"]).toBe(3);
    expect(stats.byCategory["sensor"]).toBe(2);
  });

  it("paginates with limit", async () => {
    const res = await app.inject({ method: "GET", url: "/api/components?limit=2" });
    expect((res.json() as unknown[]).length).toBe(2);
  });

  it("filters to the variants of a family", async () => {
    const familyRes = await app.inject({ method: "GET", url: "/api/components?q=STM32F103x8" });
    const family = (familyRes.json() as Array<{ id: string; mpn: string }>).find(
      (c) => c.mpn === "STM32F103x8",
    )!;
    const res = await app.inject({ method: "GET", url: `/api/components?familyId=${family.id}` });
    const variants = res.json() as Array<{ mpn: string }>;
    expect(variants.map((v) => v.mpn).sort()).toEqual(["STM32F103C8T6", "STM32F103CBT6"]);
  });
});
