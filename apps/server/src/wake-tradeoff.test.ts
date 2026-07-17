import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const dataDir = mkdtempSync(join(tmpdir(), "embedded-wake-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

const source = (page: number) => ({
  kind: "datasheet" as const,
  datasheetId: "ds1",
  page,
  snippet: "IDD row",
  verifiedBy: "machine" as const,
});

// Rows carry an explicit `mode` because that is what a real grounded part has:
// the extractor canonicalises the datasheet's own wording onto a mode at read
// time. The name-regex in specs.ts is only a fallback for rows written before
// `mode` existed, and it deliberately knows a narrower vocabulary — "Quiescent
// Current" matches nothing there and would be IGNORED rather than guessed at.

/** an MCU that wakes and sleeps — the part a cadence question is about */
const mcuSpecs = {
  powerStates: [
    { name: "IDD sleep", mode: "sleep", current: { typ: { value: 0.3, unit: "µA", source: source(11) } } },
    { name: "IDD active", mode: "active", current: { typ: { value: 6, unit: "mA", source: source(11) } } },
  ],
};

/** a regulator whose quiescent draw is simply always on */
const regSpecs = {
  powerStates: [
    {
      name: "Quiescent Current",
      mode: "active",
      current: { typ: { value: 55, unit: "µA", source: source(6) } },
    },
  ],
};

interface Option {
  everySec: number;
  label: string;
  averageCurrentMa: number;
  batteryLifeYears: number;
  meetsTarget: boolean | null;
}
interface Tradeoff {
  options: Option[];
  targetUnreachable: boolean;
  ungrounded: Array<{ name: string; reason: string }>;
  savedEverySec?: number;
}

describe("POST /projects/:id/wake-tradeoff", () => {
  let app: FastifyInstance;
  let projectId: string;
  let emptyProjectId: string;

  async function post(id: string, body: Record<string, unknown>) {
    return app.inject({ method: "POST", url: `/api/projects/${id}/wake-tradeoff`, payload: body });
  }

  beforeAll(async () => {
    app = buildApp();
    await app.ready();

    const project = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "sensor node" } });
    projectId = (project.json() as { id: string }).id;

    const empty = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "empty" } });
    emptyProjectId = (empty.json() as { id: string }).id;

    const mcu = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: { mpn: "NRF52840", category: "mcu", specs: mcuSpecs },
    });
    const reg = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: { mpn: "AP2112K-3.3", category: "power", specs: regSpecs },
    });

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/blocks`,
      payload: { name: "MCU", role: "mcu", componentId: (mcu.json() as { id: string }).id },
    });
    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/blocks`,
      payload: { name: "Regulator", role: "power", componentId: (reg.json() as { id: string }).id },
    });

    // a block with nothing bound — it must be reported, not silently skipped
    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/blocks`,
      payload: { name: "Antenna", role: "other" },
    });
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("prices every offered cadence against the real grounded currents", async () => {
    const res = await post(projectId, { batteryCapacityMah: 220 });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Tradeoff;

    expect(body.options.length).toBeGreaterThan(3);
    expect(body.options[0]?.label).toBe("every 10 seconds");
    // waking less often draws less and lasts longer — the consequence is
    // computed from the same cited currents the budget uses, not asserted
    for (let i = 1; i < body.options.length; i++) {
      expect(body.options[i]!.averageCurrentMa).toBeLessThan(body.options[i - 1]!.averageCurrentMa);
      expect(body.options[i]!.batteryLifeYears).toBeGreaterThan(body.options[i - 1]!.batteryLifeYears);
    }
  });

  it("never rescales the always-on regulator by the wake interval", async () => {
    // 55 µA quiescent is continuous. If the cadence touched it, "once a day"
    // would price this node at essentially forever.
    const res = await post(projectId, { batteryCapacityMah: 220 });
    const body = res.json() as Tradeoff;
    const daily = body.options.find((o) => o.everySec === 86_400)!;
    // the regulator alone is 0.055 mA, so nothing can go below that
    expect(daily.averageCurrentMa).toBeGreaterThan(0.055);
    expect(daily.batteryLifeYears).toBeLessThan(0.5);
  });

  it("reports a design no cadence can rescue instead of asking again", async () => {
    // The AP2112K's continuous 55 µA caps this node at ~0.45 years on 220 mAh
    // whatever the MCU does. Asking the user to keep compromising on cadence
    // would waste their time: the part choice is the problem.
    const res = await post(projectId, { batteryCapacityMah: 220, targetLifeYears: 5 });
    const body = res.json() as Tradeoff;
    expect(body.targetUnreachable).toBe(true);
    expect(body.options.every((o) => o.meetsTarget === false)).toBe(true);
  });

  it("gives no verdict when the design states no target", async () => {
    const res = await post(projectId, { batteryCapacityMah: 220 });
    const body = res.json() as Tradeoff;
    // "we don't know if this is good enough" is not "this isn't good enough"
    expect(body.options.every((o) => o.meetsTarget === null)).toBe(true);
    expect(body.targetUnreachable).toBe(false);
  });

  it("offers no options at all rather than claiming a partless design runs forever", async () => {
    // powerBudget divides capacity by draw and returns Infinity for a zero
    // draw, so an empty project would otherwise be priced at "lasts forever"
    // at every cadence — a confidently-cited absurdity.
    const res = await post(emptyProjectId, { batteryCapacityMah: 220 });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Tradeoff;
    expect(body.options).toEqual([]);
    expect(body.targetUnreachable).toBe(false);
  });

  it("accounts for the blocks it could not include", async () => {
    const res = await post(projectId, { batteryCapacityMah: 220 });
    const body = res.json() as Tradeoff;
    expect(body.ungrounded).toContainEqual({
      blockId: expect.any(String),
      name: "Antenna",
      reason: "no part bound",
    });
  });

  it("honours a caller-supplied ladder", async () => {
    const res = await post(projectId, { batteryCapacityMah: 220, candidates: [60, 3600] });
    const body = res.json() as Tradeoff;
    expect(body.options.map((o) => o.label)).toEqual(["every 1 minute", "every 1 hour"]);
  });

  it("404s for a project that does not exist", async () => {
    const res = await post("no-such-project", {});
    expect(res.statusCode).toBe(404);
  });

  it("reports no chosen cadence for a design nobody has answered for", async () => {
    // Every block still has a duty — from the role default. Reporting THAT as
    // the choice would show the designer a decision they never made.
    const res = await post(projectId, {});
    expect((res.json() as Tradeoff).savedEverySec).toBeUndefined();
  });
});

describe("POST /projects/:id/wake-cadence — the answer becomes the design", () => {
  let app: FastifyInstance;
  let projectId: string;
  let mcuBlockId: string;
  let regBlockId: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    const project = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "commit" } });
    projectId = (project.json() as { id: string }).id;

    const mcu = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: { mpn: "MCU-2", category: "mcu", specs: mcuSpecs },
    });
    const reg = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: { mpn: "REG-2", category: "power", specs: regSpecs },
    });
    const mcuBlock = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/blocks`,
      payload: { name: "MCU", role: "mcu", componentId: (mcu.json() as { id: string }).id },
    });
    mcuBlockId = (mcuBlock.json() as { id: string }).id;
    const regBlock = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/blocks`,
      payload: { name: "Regulator", role: "power", componentId: (reg.json() as { id: string }).id },
    });
    regBlockId = (regBlock.json() as { id: string }).id;
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
  });

  const choose = (everySec: number) =>
    app.inject({ method: "POST", url: `/api/projects/${projectId}/wake-cadence`, payload: { everySec } });

  const blocksNow = async () => {
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/blocks` });
    return res.json() as Array<{ id: string; duties: Record<string, { everySec: number; forMs: number }> }>;
  };

  it("writes the chosen cadence onto the design and reports it back", async () => {
    expect((await choose(600)).statusCode).toBe(200);

    const mcu = (await blocksNow()).find((b) => b.id === mcuBlockId)!;
    expect(mcu.duties["active"]).toEqual({ everySec: 600, forMs: 1000 });

    // and the panel is told what the design says, so the highlight survives a reload
    const tradeoff = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/wake-tradeoff`,
      payload: {},
    });
    expect((tradeoff.json() as Tradeoff).savedEverySec).toBe(600);
  });

  it("leaves the always-on regulator alone", async () => {
    await choose(3600);
    // 55 µA quiescent is continuous. Writing "every 3600 s" onto it would make
    // the saved design claim the regulator switches off between readings.
    const reg = (await blocksNow()).find((b) => b.id === regBlockId)!;
    expect(reg.duties).toEqual({});
  });

  it("moves the budget to the number the trade-off promised", async () => {
    await choose(600);
    const priced = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/wake-tradeoff`,
      payload: { batteryCapacityMah: 220, candidates: [600] },
    });
    const promised = (priced.json() as Tradeoff).options[0]!.averageCurrentMa;

    const budget = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/power-budget`,
      payload: { batteryCapacityMah: 220 },
    });
    // choosing an option has to mean what the option said it meant
    expect((budget.json() as { averageCurrentMa: number }).averageCurrentMa).toBeCloseTo(promised, 6);
  });

  it("rejects a cadence that is not a duration", async () => {
    expect((await choose(0)).statusCode).toBe(400);
  });

  it("404s for a project that does not exist", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/nope/wake-cadence",
      payload: { everySec: 60 },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe("a saved duty is the designer's answer", () => {
  let app: FastifyInstance;
  let projectId: string;
  let mcuBlockId: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    const project = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "saved duty" } });
    projectId = (project.json() as { id: string }).id;
    const mcu = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: { mpn: "MCU-1", category: "mcu", specs: mcuSpecs },
    });
    const block = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/blocks`,
      payload: { name: "MCU", role: "mcu", componentId: (mcu.json() as { id: string }).id },
    });
    mcuBlockId = (block.json() as { id: string }).id;
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
  });

  async function budget() {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/power-budget`,
      payload: { batteryCapacityMah: 220 },
    });
    return (res.json() as { averageCurrentMa: number }).averageCurrentMa;
  }

  it("survives the request that set it and outranks the role default", async () => {
    // The role default is active 1000 ms every 60 s. Answering the cadence
    // question has to STICK — a decision that evaporates when the page reloads
    // is not a decision, and the budget would quietly drift back to a guess.
    const before = await budget();

    const saved = await app.inject({
      method: "PATCH",
      url: `/api/blocks/${mcuBlockId}`,
      payload: { duties: { active: { everySec: 600, forMs: 1000 } } },
    });
    expect(saved.statusCode).toBe(200);
    expect((saved.json() as { duties: Record<string, unknown> }).duties).toEqual({
      active: { everySec: 600, forMs: 1000 },
    });

    // 1 s awake in 600 s instead of in 60 s — a tenth of the active draw
    const after = await budget();
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(0.0003 + 6 / 600, 4);
  });

  it("is still outranked by an explicit what-if on the request", async () => {
    // The saved answer is the design; the request's duties are an unsaved
    // preview the trade-off panel drives. A preview must win without
    // overwriting what the designer chose.
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/power-budget`,
      payload: { batteryCapacityMah: 220, duties: { [mcuBlockId]: { active: { everySec: 60, forMs: 1000 } } } },
    });
    expect((res.json() as { averageCurrentMa: number }).averageCurrentMa).toBeCloseTo(0.0003 + 6 / 60, 4);

    // and the saved value is untouched by the preview
    const block = await app.inject({ method: "GET", url: `/api/projects/${projectId}/blocks` });
    const blocks = block.json() as Array<{ id: string; duties: Record<string, unknown> }>;
    expect(blocks.find((b) => b.id === mcuBlockId)?.duties).toEqual({
      active: { everySec: 600, forMs: 1000 },
    });
  });
});
