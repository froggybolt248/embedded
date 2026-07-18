import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Same isolation seam as app.test.ts: EMBEDDED_DATA_DIR before importing app.js,
// so nothing here can ever touch the real library.
const dataDir = mkdtempSync(join(tmpdir(), "embedded-simulate-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

describe("simulate capability + refusal", () => {
  let app: FastifyInstance;
  let projectId: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Sim Test" },
    });
    projectId = (created.json() as { id: string }).id;
  });

  afterAll(async () => {
    // sqlite keeps the file locked until its client is closed — same teardown
    // as grounding-persistence.test.ts, or rmSync EPERMs on Windows
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("reports all three legs honestly on a bare machine and design", async () => {
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/simulate/capability` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      target: { supported: boolean; detail?: string };
      supportedBoards: string[];
      renode: { present: boolean; detail?: string };
      platformio: { present: boolean };
    };
    // no MCU bound → not supported, and it says why rather than guessing a board
    expect(body.target.supported).toBe(false);
    expect(body.target.detail).toMatch(/no MCU/i);
    expect(body.supportedBoards).toContain("nRF52840 DK");
    // fresh temp data dir → simulator honestly absent, with download guidance
    expect(body.renode.present).toBe(false);
    expect(body.renode.detail).toMatch(/download/i);
  });

  it("refuses to run with the missing leg named, not a timeout", async () => {
    const res = await app.inject({ method: "POST", url: `/api/projects/${projectId}/simulate/run` });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toMatch(/no MCU part is bound/i);
  });

  it("404s on a project that does not exist", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/nope/simulate/capability" });
    expect(res.statusCode).toBe(404);
  });
});
