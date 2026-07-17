import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const dataDir = mkdtempSync(join(tmpdir(), "embedded-findings-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

interface Finding {
  ruleId: string;
  severity: "info" | "warning" | "error";
  message: string;
  status: "failed" | "needs-input" | "broken";
  missingInputs: string[];
  subject: { kind: string; id: string; label: string };
}

const source = (page: number) => ({
  kind: "datasheet" as const,
  datasheetId: "ds1",
  page,
  snippet: "row",
  verifiedBy: "machine" as const,
});

/** a 3.3 V part: rated to 3.6 V absolute max, specified down to 1.7 V */
const sensorSpecs = {
  absoluteMax: [{ name: "VDD", value: { value: 3.6, unit: "V", source: source(13) } }],
  recommendedOperating: [
    { name: "VDD", value: { value: 1.7, unit: "V", source: source(14) }, kind: "min" },
  ],
  powerStates: [
    { name: "IDD active", mode: "active", current: { typ: { value: 1, unit: "mA", source: source(11) } } },
  ],
};

describe("GET /projects/:id/findings", () => {
  let app: FastifyInstance;
  let projectId: string;
  let mcuBlockId: string;
  let sensorBlockId: string;

  const findings = async (id = projectId): Promise<Finding[]> => {
    const res = await app.inject({ method: "GET", url: `/api/projects/${id}/findings` });
    return (res.json() as { findings: Finding[] }).findings;
  };

  beforeAll(async () => {
    app = buildApp();
    await app.ready();

    const project = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "wired node" } });
    projectId = (project.json() as { id: string }).id;

    const sensor = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: { mpn: "BME280", category: "sensor", specs: sensorSpecs },
    });
    const sensorId = (sensor.json() as { id: string }).id;

    const mcu = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/blocks`,
      payload: { name: "MCU", role: "mcu" },
    });
    mcuBlockId = (mcu.json() as { id: string }).id;

    const sensorBlock = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/blocks`,
      payload: { name: "Sensor", role: "sensor", componentId: sensorId },
    });
    sensorBlockId = (sensorBlock.json() as { id: string }).id;
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("seeds the shipped rules at boot, so a fresh install actually checks things", async () => {
    // A boot that silently skipped the rules would report every design clean —
    // the worst failure available to this app.
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/findings` });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray((res.json() as { findings: unknown }).findings)).toBe(true);
  });

  it("asks for the bus capacitance instead of assuming one", async () => {
    // The whole point. Bus capacitance depends on a board that does not exist
    // yet: nothing can derive it, and a plausible default would silently decide
    // whether this bus is in spec. So the pull-up rule must report that it needs
    // the number — not pass, not fail, and above all not vanish.
    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/connections`,
      payload: {
        fromBlockId: mcuBlockId,
        toBlockId: sensorBlockId,
        interface: "i2c",
        attrs: { voltage: 3.3, busSpeedHz: 400_000, pullupOhms: 4700 },
      },
    });

    const weak = (await findings()).find((f) => f.ruleId === "i2c-pullup-too-weak");
    expect(weak).toBeDefined();
    expect(weak?.status).toBe("needs-input");
    expect(weak?.missingInputs).toContain("busCapacitanceF");
  });

  it("catches the 4.7k-at-400kHz bus once it knows the capacitance", async () => {
    // The canonical field failure: 4.7 kΩ is fine at 100 kHz and out of spec at
    // 400 kHz with any real trace capacitance, so the bus works on the bench.
    // 4700 * 200e-12 = 940 ns, way past the 300 ns / 0.8473 = 354 ns budget.
    const list = await app.inject({ method: "GET", url: `/api/projects/${projectId}/connections` });
    const conn = (list.json() as Array<{ id: string }>)[0]!;
    await app.inject({
      method: "PATCH",
      url: `/api/connections/${conn.id}`,
      payload: {
        attrs: { voltage: 3.3, busSpeedHz: 400_000, pullupOhms: 4700, busCapacitanceF: 200e-12 },
      },
    });

    const weak = (await findings()).find((f) => f.ruleId === "i2c-pullup-too-weak");
    expect(weak?.status).toBe("failed");
    expect(weak?.severity).toBe("warning");
    // the message must carry the actual numbers, not a generic scolding
    expect(weak?.message).toMatch(/4700/);
  });

  it("passes a bus that is actually in spec, rather than always complaining", async () => {
    // 1 kΩ * 200 pF = 200 ns, inside the 354 ns budget, and 1 kΩ is still weak
    // enough to sink at 0.4 V. A rule that fired here would be noise.
    const list = await app.inject({ method: "GET", url: `/api/projects/${projectId}/connections` });
    const conn = (list.json() as Array<{ id: string }>)[0]!;
    await app.inject({
      method: "PATCH",
      url: `/api/connections/${conn.id}`,
      payload: {
        attrs: { voltage: 3.3, busSpeedHz: 400_000, pullupOhms: 1000, busCapacitanceF: 200e-12 },
      },
    });

    const ids = (await findings()).map((f) => f.ruleId);
    expect(ids).not.toContain("i2c-pullup-too-weak");
    expect(ids).not.toContain("i2c-pullup-too-strong");
  });

  it("names the block a finding is about, never a bare id", async () => {
    const all = await findings();
    for (const f of all) {
      expect(f.subject.label).not.toBe("");
      expect(f.subject.label).not.toBe(f.subject.id);
    }
  });

  it("404s for a project that does not exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/nope/findings" });
    expect(res.statusCode).toBe(404);
  });
});
