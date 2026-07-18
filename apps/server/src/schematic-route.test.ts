import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Same isolation seam as app.test.ts / firmware-route.test.ts: point
// EMBEDDED_DATA_DIR at a throwaway temp dir before buildApp() ever touches
// the db, so this test never runs against the user's real data.
const dataDir = mkdtempSync(join(tmpdir(), "embedded-schematic-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

describe("schematic route", () => {
  let app: FastifyInstance;
  let projectId: string;
  let mcuId: string;
  let sensorId: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Schematic Test Project" },
    });
    projectId = (project.json() as { id: string }).id;

    const mcuComponent = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: {
        mpn: "TESTMCU1",
        manufacturer: "TestCo",
        category: "mcu",
        specs: {
          pins: [
            { name: "VDD", functions: ["supply"] },
            { name: "GND", functions: ["ground"] },
            { name: "SDA", functions: ["i2c-sda"] },
            { name: "SCL", functions: ["i2c-scl"] },
          ],
        },
      },
    });
    const mcuComponentId = (mcuComponent.json() as { id: string }).id;

    const sensorComponent = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: {
        mpn: "TESTSENSOR1",
        manufacturer: "TestCo",
        category: "sensor",
        specs: {
          pins: [
            { name: "VDD", functions: ["supply"] },
            { name: "GND", functions: ["ground"] },
            { name: "SDA", functions: ["i2c-sda"] },
            { name: "SCL", functions: ["i2c-scl"] },
          ],
        },
      },
    });
    const sensorComponentId = (sensorComponent.json() as { id: string }).id;

    const mcu = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/blocks`,
      payload: { name: "MCU", role: "mcu", componentId: mcuComponentId },
    });
    mcuId = (mcu.json() as { id: string }).id;

    const sensor = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/blocks`,
      payload: { name: "Environment sensor", role: "sensor", componentId: sensorComponentId },
    });
    sensorId = (sensor.json() as { id: string }).id;

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/connections`,
      payload: {
        fromBlockId: mcuId,
        toBlockId: sensorId,
        interface: "i2c",
        attrs: { voltage: 3.3, busSpeedHz: 400_000, busCapacitanceF: 100e-12 },
      },
    });

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/connections`,
      payload: {
        fromBlockId: mcuId,
        toBlockId: sensorId,
        interface: "power",
        attrs: { voltage: 3.3 },
      },
    });
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("returns a full schematic built from the project's real design", async () => {
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/schematic` });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      symbols: Array<{ blockId: string; label: string; pins: unknown[] }>;
      nets: Array<{ id: string; kind: string }>;
      passives: Array<{ designator: string; kind: string }>;
      gaps: unknown[];
    };

    expect(body.symbols).toHaveLength(2);
    const mcuSymbol = body.symbols.find((s) => s.blockId === mcuId)!;
    expect(mcuSymbol.pins.length).toBeGreaterThan(0);

    expect(body.nets.some((n) => n.id === "GND" && n.kind === "ground")).toBe(true);
    expect(body.nets.some((n) => n.id === "VDD_3V3" && n.kind === "power")).toBe(true);
    expect(body.nets.some((n) => n.id.endsWith("_SDA"))).toBe(true);
    expect(body.nets.some((n) => n.id.endsWith("_SCL"))).toBe(true);

    expect(body.passives.some((p) => p.kind === "capacitor")).toBe(true);
    expect(body.passives.some((p) => p.kind === "resistor")).toBe(true);
  });

  it("404s for a project that does not exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/no-such-project/schematic" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe("project not found");
  });
});
