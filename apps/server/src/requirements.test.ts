import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const dataDir = mkdtempSync(join(tmpdir(), "embedded-requirements-route-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

describe("requirement routes", () => {
  let app: FastifyInstance;
  let projectId: string;

  const newProject = async (name: string) => {
    const res = await app.inject({ method: "POST", url: "/api/projects", payload: { name } });
    return (res.json() as { id: string }).id;
  };

  beforeAll(async () => {
    // buildApp registers requirementRoutes itself now — registering again here
    // would define every route twice
    app = buildApp();
    await app.ready();
    projectId = await newProject("requirements project");
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("404s listing requirements for an unknown project", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/no-such-project/requirements" });
    expect(res.statusCode).toBe(404);
  });

  it("400s creating a requirement with invalid input", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/requirements`,
      payload: { text: "" },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { issues: unknown[] }).issues).toBeDefined();
  });

  it("creates a requirement with quantified: null and treats it as normal, not an error", () => {
    return app
      .inject({
        method: "POST",
        url: `/api/projects/${projectId}/requirements`,
        payload: { text: "Must fit in enclosure", quantified: null },
      })
      .then((res) => {
        expect(res.statusCode).toBe(201);
        const created = res.json() as { id: string; quantified: unknown; text: string };
        expect(created.quantified).toBeNull();
        expect(created.text).toBe("Must fit in enclosure");
      });
  });

  it("creates a quantified requirement and round-trips it through GET", async () => {
    const quantified = { param: "avgCurrent", op: "<=", value: 25, unit: "µA" };
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/requirements`,
      payload: { text: "Average current must stay low", kind: "power", quantified },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as { id: string; quantified: unknown };
    expect(body.quantified).toEqual(quantified);

    const list = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/requirements`,
    });
    expect(list.statusCode).toBe(200);
    const found = (list.json() as Array<{ id: string; quantified: unknown }>).find(
      (r) => r.id === body.id,
    );
    expect(found?.quantified).toEqual(quantified);
  });

  it("lists requirements for a project", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/requirements`,
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as unknown[]).length).toBeGreaterThan(0);
  });

  it("patches a requirement, updating only the given fields", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/requirements`,
      payload: { text: "Original text", kind: "cost" },
    });
    const id = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${id}`,
      payload: { status: "met" },
    });
    expect(res.statusCode).toBe(200);
    const updated = res.json() as { status: string; text: string; kind: string };
    expect(updated.status).toBe("met");
    expect(updated.text).toBe("Original text");
    expect(updated.kind).toBe("cost");
  });

  it("400s patching a requirement with invalid input", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/requirements`,
      payload: { text: "Another requirement" },
    });
    const id = (created.json() as { id: string }).id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/requirements/${id}`,
      payload: { kind: "not-a-real-kind" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("404s patching a requirement that does not exist", async () => {
    const res = await app.inject({
      method: "PATCH",
      url: "/api/requirements/nope",
      payload: { status: "met" },
    });
    expect(res.statusCode).toBe(404);
  });

  it("deletes a requirement", async () => {
    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/requirements`,
      payload: { text: "To be deleted" },
    });
    const id = (created.json() as { id: string }).id;

    const res = await app.inject({ method: "DELETE", url: `/api/requirements/${id}` });
    expect(res.statusCode).toBe(204);

    const list = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/requirements`,
    });
    expect((list.json() as Array<{ id: string }>).some((r) => r.id === id)).toBe(false);
  });
});
