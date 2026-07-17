import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Isolation seam: @embedded/db's appDataDir() (packages/db/src/paths.ts) reads
// EMBEDDED_DATA_DIR before falling back to %APPDATA%/embedded, and both the
// sqlite DB path (databasePath()) and the settings.json path used by
// src/services/llm-settings.ts derive from appDataDir(). Pointing this env
// var at a throwaway temp dir before buildApp() creates the db keeps every
// test off the user's real database and real settings file.
const dataDir = mkdtempSync(join(tmpdir(), "embedded-server-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

describe("server routes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    // Close the underlying better-sqlite3 handle explicitly — app.close()
    // tears down Fastify but leaves the sqlite file (and its WAL/SHM
    // siblings) open, which makes rmSync fail with EPERM on Windows.
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  describe("GET /api/health", () => {
    it("returns 200 with ok true", async () => {
      const res = await app.inject({ method: "GET", url: "/api/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true, version: "0.1.0" });
    });
  });

  describe("LLM settings", () => {
    it("GET /api/llm/settings returns the persisted (default) settings shape", async () => {
      const res = await app.inject({ method: "GET", url: "/api/llm/settings" });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.activeProvider).toBe("ollama");
      expect(body.ollama.models).toEqual({
        triage: "qwen3:4b",
        extraction: "qwen2.5vl:7b",
        assistant: "qwen3:4b",
      });
      expect(body.claudeCode.models).toBeDefined();
      expect(body.openaiCompat.models).toBeDefined();
    });

    it("PUT /api/llm/settings rejects an invalid body with 400", async () => {
      const res = await app.inject({
        method: "PUT",
        url: "/api/llm/settings",
        payload: { activeProvider: "not-a-real-provider" },
      });
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(body.error).toBe("invalid settings");
      expect(Array.isArray(body.issues)).toBe(true);
    });

    it("PUT /api/llm/settings accepts a valid body and persists it, reflected on GET", async () => {
      const putRes = await app.inject({
        method: "PUT",
        url: "/api/llm/settings",
        payload: {
          activeProvider: "ollama",
          ollama: {
            baseUrl: "http://localhost:11434",
            numCtx: 8192,
            models: { triage: "qwen3:4b", extraction: "qwen2.5vl:7b", assistant: "qwen3:4b" },
          },
        },
      });
      expect(putRes.statusCode).toBe(200);
      expect(putRes.json().ollama.numCtx).toBe(8192);

      const getRes = await app.inject({ method: "GET", url: "/api/llm/settings" });
      expect(getRes.json().ollama.numCtx).toBe(8192);
    });
  });

  describe("projects", () => {
    it("supports create -> get -> list -> delete round trip", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { name: "Weather Station" },
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json();
      expect(created.id).toBeTruthy();
      expect(created.name).toBe("Weather Station");

      const getRes = await app.inject({ method: "GET", url: `/api/projects/${created.id}` });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().id).toBe(created.id);

      const listRes = await app.inject({ method: "GET", url: "/api/projects" });
      expect(listRes.statusCode).toBe(200);
      const list = listRes.json() as Array<{ id: string }>;
      expect(list.some((p) => p.id === created.id)).toBe(true);

      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/api/projects/${created.id}`,
      });
      expect(deleteRes.statusCode).toBe(204);

      const getAfterDeleteRes = await app.inject({
        method: "GET",
        url: `/api/projects/${created.id}`,
      });
      expect(getAfterDeleteRes.statusCode).toBe(404);
    });

    it("returns 404 for a missing project id", async () => {
      const res = await app.inject({ method: "GET", url: "/api/projects/does-not-exist" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("project not found");
    });

    it("returns 400 for an invalid create body (missing name)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: { description: "no name given" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid input");
    });
  });

  describe("components", () => {
    it("supports create -> get -> list -> delete round trip", async () => {
      const createRes = await app.inject({
        method: "POST",
        url: "/api/components",
        payload: { mpn: "BME280", manufacturer: "Bosch", category: "sensor" },
      });
      expect(createRes.statusCode).toBe(201);
      const created = createRes.json();
      expect(created.id).toBeTruthy();
      expect(created.mpn).toBe("BME280");

      const getRes = await app.inject({ method: "GET", url: `/api/components/${created.id}` });
      expect(getRes.statusCode).toBe(200);
      expect(getRes.json().id).toBe(created.id);

      const listRes = await app.inject({ method: "GET", url: "/api/components" });
      expect(listRes.statusCode).toBe(200);
      const list = listRes.json() as Array<{ id: string }>;
      expect(list.some((c) => c.id === created.id)).toBe(true);

      const deleteRes = await app.inject({
        method: "DELETE",
        url: `/api/components/${created.id}`,
      });
      expect(deleteRes.statusCode).toBe(204);

      const getAfterDeleteRes = await app.inject({
        method: "GET",
        url: `/api/components/${created.id}`,
      });
      expect(getAfterDeleteRes.statusCode).toBe(404);
    });

    it("returns 404 for a missing component id", async () => {
      const res = await app.inject({ method: "GET", url: "/api/components/does-not-exist" });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe("component not found");
    });

    it("returns 400 for an invalid create body (missing mpn)", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/components",
        payload: { manufacturer: "Bosch" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid input");
    });

    it("returns 400 for an invalid category filter on list", async () => {
      const res = await app.inject({ method: "GET", url: "/api/components?category=not-real" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe("invalid category");
    });
  });
});
