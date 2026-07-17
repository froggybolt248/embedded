import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const dataDir = mkdtempSync(join(tmpdir(), "embedded-blocks-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

const source = (page: number) => ({
  kind: "datasheet" as const,
  datasheetId: "ds1",
  page,
  snippet: "IDD sleep 0.1 µA",
  verifiedBy: "machine" as const,
});

/** a grounded part, as it looks after deepening merged the datasheet in */
const groundedSpecs = {
  powerStates: [
    { name: "sleep", current: { typ: { value: 0.1, unit: "µA", source: source(11) } } },
    { name: "active measuring", current: { typ: { value: 714, unit: "µA", source: source(11) } } },
  ],
  pins: [{ name: "VDD", number: "1", functions: ["supply"] }],
};

describe("project blocks and the power budget", () => {
  let app: FastifyInstance;
  let projectId: string;
  let groundedId: string;
  let skeletonId: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "weather station" },
    });
    projectId = (project.json() as { id: string }).id;

    const grounded = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: { mpn: "BME280", category: "sensor", specs: groundedSpecs },
    });
    groundedId = (grounded.json() as { id: string }).id;

    // a bulk-imported part with no datasheet URL — nothing to deepen from
    const skeleton = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: { mpn: "MYSTERY-1", category: "other" },
    });
    skeletonId = (skeleton.json() as { id: string }).id;
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  const addBlock = async (payload: Record<string, unknown>) => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/blocks`,
      payload,
    });
    expect(res.statusCode).toBe(201);
    return res.json() as { id: string };
  };

  it("creates and lists blocks for a project", async () => {
    await addBlock({ name: "Sensor", role: "sensor" });
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/blocks` });
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBe(1);
  });

  it("binds a part to a block", async () => {
    const blocks = await app.inject({ method: "GET", url: `/api/projects/${projectId}/blocks` });
    const blockId = (blocks.json() as Array<{ id: string }>)[0]!.id;
    const res = await app.inject({
      method: "PATCH",
      url: `/api/blocks/${blockId}`,
      payload: { componentId: groundedId },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { componentId: string }).componentId).toBe(groundedId);
  });

  it("saves and returns a block's measured currents, keyed by mode", async () => {
    // its own project, so this stays a plain unbound block and never shows up
    // as an "ungrounded" surprise in the shared project's later budget assertions
    const otherProject = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "measured-currents scratch project" },
    });
    const otherProjectId = (otherProject.json() as { id: string }).id;

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${otherProjectId}/blocks`,
      payload: { name: "Measured sensor", role: "sensor" },
    });
    expect(created.statusCode).toBe(201);
    const block = created.json() as { id: string; measuredMa: Record<string, number> };
    expect(block.measuredMa).toEqual({});

    const measuredMa = { active: 12.4, sleep: 0.0009 };
    const patch = await app.inject({
      method: "PATCH",
      url: `/api/blocks/${block.id}`,
      payload: { measuredMa },
    });
    expect(patch.statusCode).toBe(200);
    expect((patch.json() as { measuredMa: Record<string, number> }).measuredMa).toEqual(measuredMa);

    const get = await app.inject({ method: "GET", url: `/api/projects/${otherProjectId}/blocks` });
    const fetched = (get.json() as Array<{ id: string; measuredMa: Record<string, number> }>).find(
      (b) => b.id === block.id,
    );
    expect(fetched?.measuredMa).toEqual(measuredMa);
  });

  const budgetFor = async (payload: Record<string, unknown> = {}) => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/power-budget`,
      payload,
    });
    expect(res.statusCode).toBe(200);
    return res.json() as {
      averageCurrentMa: number;
      batteryLifeYears: number;
      contributions: Array<{ id: string; label: string; states: Array<{ mode: string }> }>;
      ungrounded: Array<{ blockId: string; reason: string }>;
    };
  };

  it("builds a budget from the bound part's grounded currents using role defaults", async () => {
    const budget = await budgetFor({ batteryCapacityMah: 220 });
    expect(budget.contributions[0]?.label).toContain("BME280");
    expect(budget.ungrounded).toHaveLength(0);
    // sensor default is 500 ms every 60 s → 0.8333% active
    // 0.008333*0.714 + 0.991667*0.0001 = 0.006050 mA
    expect(budget.averageCurrentMa).toBeCloseTo(0.00604917, 6);
    expect(budget.batteryLifeYears).toBeGreaterThan(3);
  });

  it("honours a per-block duty override", async () => {
    const blocks = await app.inject({ method: "GET", url: `/api/projects/${projectId}/blocks` });
    const blockId = (blocks.json() as Array<{ id: string }>)[0]!.id;
    const budget = await budgetFor({
      batteryCapacityMah: 220,
      duties: { [blockId]: { active: { everySec: 60, forMs: 600 } } },
    });
    // 600/60000 = 1% → 0.01*0.714 + 0.99*0.0001 = 0.007239 mA
    expect(budget.averageCurrentMa).toBeCloseTo(0.007239, 6);
  });

  it("reports an ungrounded part instead of guessing a number for it", async () => {
    const block = await addBlock({ name: "Unknown", role: "other", componentId: skeletonId });
    const budget = await budgetFor();
    const entry = budget.ungrounded.find((u) => u.blockId === block.id);
    expect(entry).toBeDefined();
    expect(entry?.reason).toBeTruthy();
  });

  it("reports per-block grounding status", async () => {
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/grounding` });
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Array<{ componentId: string | null; status: string }>;
    expect(rows.find((r) => r.componentId === groundedId)?.status).toBe("grounded");
    expect(rows.find((r) => r.componentId === skeletonId)?.status).toBe("unavailable");
  });
});
