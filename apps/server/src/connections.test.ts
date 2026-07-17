import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const dataDir = mkdtempSync(join(tmpdir(), "embedded-conn-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

describe("connection routes", () => {
  let app: FastifyInstance;
  let projectId: string;
  let otherProjectId: string;
  let mcuId: string;
  let sensorId: string;
  /** a block belonging to a DIFFERENT project */
  let foreignBlockId: string;

  const newProject = async (name: string) => {
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return (res.json() as { id: string }).id;
  };
  const newBlock = async (project: string, name: string, role: string) => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${project}/blocks`,
      payload: { name, role },
    });
    return (res.json() as { id: string }).id;
  };
  const connect = (project: string, payload: Record<string, unknown>) =>
    app.inject({ method: "POST", url: `/api/projects/${project}/connections`, payload });

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    projectId = await newProject("wired");
    otherProjectId = await newProject("elsewhere");
    mcuId = await newBlock(projectId, "MCU", "mcu");
    sensorId = await newBlock(projectId, "Environment sensor", "sensor");
    foreignBlockId = await newBlock(otherProjectId, "Someone else's MCU", "mcu");
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("wires two blocks together and lists the result", async () => {
    const res = await connect(projectId, {
      fromBlockId: mcuId,
      toBlockId: sensorId,
      interface: "i2c",
      attrs: { voltage: 3.3, busSpeedHz: 400_000 },
    });
    expect(res.statusCode).toBe(201);
    const created = res.json() as { id: string; attrs: Record<string, number> };
    expect(created.attrs).toEqual({ voltage: 3.3, busSpeedHz: 400_000 });

    const list = await app.inject({ method: "GET", url: `/api/projects/${projectId}/connections` });
    expect((list.json() as unknown[]).length).toBe(1);
  });

  it("refuses to wire in a block from another project", async () => {
    // The foreign key is satisfied — the block really does exist — so nothing
    // below this route would catch it. Every downstream check then looks for
    // that block's part among THIS design's blocks and finds nothing.
    const res = await connect(projectId, {
      fromBlockId: mcuId,
      toBlockId: foreignBlockId,
      interface: "i2c",
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toMatch(/not a block of this project/);
  });

  it("refuses to wire a block to itself", async () => {
    const res = await connect(projectId, {
      fromBlockId: mcuId,
      toBlockId: mcuId,
      interface: "i2c",
    });
    expect(res.statusCode).toBe(400);
  });

  it("does not let a patch walk a connection out of its project", async () => {
    const created = await connect(projectId, {
      fromBlockId: mcuId,
      toBlockId: sensorId,
      interface: "spi",
    });
    const id = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/connections/${id}`,
      payload: { toBlockId: foreignBlockId },
    });
    expect(res.statusCode).toBe(400);
  });

  it("records the pull-up actually fitted, and leaves the rest alone", async () => {
    const created = await connect(projectId, {
      fromBlockId: mcuId,
      toBlockId: sensorId,
      interface: "i2c",
      attrs: { voltage: 3.3, busSpeedHz: 400_000 },
    });
    const id = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/connections/${id}`,
      payload: { attrs: { voltage: 3.3, busSpeedHz: 400_000, pullupOhms: 4700 } },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json() as { interface: string; attrs: Record<string, number> };
    expect(updated.attrs["pullupOhms"]).toBe(4700);
    expect(updated.interface).toBe("i2c");
  });

  it("rejects an interface it does not know", async () => {
    const res = await connect(projectId, {
      fromBlockId: mcuId,
      toBlockId: sensorId,
      interface: "telepathy",
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s for a project that does not exist", async () => {
    const res = await connect("no-such-project", {
      fromBlockId: mcuId,
      toBlockId: sensorId,
      interface: "i2c",
    });
    expect(res.statusCode).toBe(404);
  });

  it("404s when patching a connection that does not exist", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/connections/nope",
      payload: { interface: "spi" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("forgets a connection whose block is removed", async () => {
    const doomed = await newBlock(projectId, "Doomed", "other");
    await connect(projectId, { fromBlockId: mcuId, toBlockId: doomed, interface: "gpio" });
    const before = ((await app.inject({ method: "GET", url: `/api/projects/${projectId}/connections` })).json() as unknown[]).length;

    await app.inject({ method: "DELETE", url: `/api/blocks/${doomed}` });

    // a wire to a part that is no longer in the design is not a wire
    const after = ((await app.inject({ method: "GET", url: `/api/projects/${projectId}/connections` })).json() as unknown[]).length;
    expect(after).toBe(before - 1);
  });
});
