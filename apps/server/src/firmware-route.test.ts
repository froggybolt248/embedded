import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const dataDir = mkdtempSync(join(tmpdir(), "embedded-firmware-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

describe("firmware routes", () => {
  let app: FastifyInstance;
  let projectId: string;
  let mcuId: string;
  let sensorId: string;

  beforeAll(async () => {
    // buildApp registers firmwareRoutes itself now — a second registration
    // would define every route twice
    app = buildApp();
    await app.ready();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Firmware Test Project" },
    });
    projectId = (project.json() as { id: string }).id;

    const mcu = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/blocks`,
      payload: { name: "MCU", role: "mcu" },
    });
    mcuId = (mcu.json() as { id: string }).id;

    const sensor = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/blocks`,
      payload: { name: "Environment sensor", role: "sensor" },
    });
    sensorId = (sensor.json() as { id: string }).id;

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/connections`,
      payload: {
        fromBlockId: mcuId,
        toBlockId: sensorId,
        interface: "i2c",
        attrs: { busSpeedHz: 400_000 },
      },
    });
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("returns pins.h and platformio.ini built from the project's real design", async () => {
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/firmware` });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { files: { name: string; kind: string; content: string }[] };
    expect(body.files).toHaveLength(2);

    const pins = body.files.find((f) => f.name === "pins.h");
    const ini = body.files.find((f) => f.name === "platformio.ini");
    expect(pins).toBeDefined();
    expect(ini).toBeDefined();
    expect(pins!.kind).toBe("pinmap-header");
    expect(ini!.kind).toBe("platformio-ini");

    expect(pins!.content).toContain("MCU");
    expect(pins!.content).toContain("Environment sensor");
    expect(pins!.content).toMatch(/#error "pins\.h: \d+ pin\(s\) not assigned/);
  });

  it("404s for a project that does not exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/no-such-project/firmware" });
    expect(res.statusCode).toBe(404);
  });

  it("round-trips pinAssignments through PATCH, GET, and generated firmware", async () => {
    const list = await app.inject({ method: "GET", url: `/api/projects/${projectId}/connections` });
    const conn = (list.json() as { id: string; attrs: Record<string, unknown> }[])[0]!;

    const patch = await app.inject({
      method: "PATCH",
      url: `/api/connections/${conn.id}`,
      payload: {
        attrs: {
          ...conn.attrs,
          pinAssignments: { SDA: { from: "GPIO4" }, SCL: { from: "GPIO5" } },
        },
      },
    });
    expect(patch.statusCode).toBe(200);

    const getAfter = await app.inject({ method: "GET", url: `/api/projects/${projectId}/connections` });
    const updated = (getAfter.json() as { attrs: { pinAssignments?: unknown } }[])[0]!;
    expect(updated.attrs.pinAssignments).toEqual({ SDA: { from: "GPIO4" }, SCL: { from: "GPIO5" } });

    const firmware = await app.inject({ method: "GET", url: `/api/projects/${projectId}/firmware` });
    const pins = (firmware.json() as { files: { name: string; content: string }[] }).files.find((f) => f.name === "pins.h")!;
    expect(pins.content).toMatch(/#define MCU_ENVIRONMENT_SENSOR_I2C_SDA GPIO4 {2}\/\*/);
    expect(pins.content).toMatch(/#define MCU_ENVIRONMENT_SENSOR_I2C_SCL GPIO5 {2}\/\*/);
    expect(pins.content).not.toMatch(/^#error/m);
  });
});
