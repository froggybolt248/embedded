import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const dataDir = mkdtempSync(join(tmpdir(), "embedded-arch-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

/**
 * Starting from an archetype is the app's answer to "what am I even building?"
 * — these cover the seam between the shipped recipe and a real project.
 */
describe("archetypes", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("seeds the shipped archetypes on boot", async () => {
    const res = await app.inject({ method: "GET", url: "/api/archetypes" });
    expect(res.statusCode).toBe(200);
    const list = res.json() as Array<{ id: string; recipe: { suggestedBlocks: unknown[] } }>;
    expect(list.length).toBeGreaterThanOrEqual(5);
    const lora = list.find((a) => a.id === "lora-node")!;
    expect(lora.recipe.suggestedBlocks.length).toBeGreaterThan(0);
  });

  it("lays out a project's architecture from the recipe", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "node", archetypeId: "lora-node" },
    });
    expect(created.statusCode).toBe(201);
    const project = created.json() as { id: string };

    const res = await app.inject({ method: "GET", url: `/api/projects/${project.id}/blocks` });
    const blocks = res.json() as Array<{ name: string; role: string; notes: string }>;

    expect(blocks.map((b) => b.role)).toContain("radio");
    expect(blocks.map((b) => b.role)).toContain("mcu");
    // every seeded block explains why it is there — that hint is the teaching
    expect(blocks.every((b) => b.notes.length > 0)).toBe(true);
  });

  it("leaves an archetype-less project empty rather than guessing", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "freeform" },
    });
    const project = created.json() as { id: string };
    const res = await app.inject({ method: "GET", url: `/api/projects/${project.id}/blocks` });
    expect(res.json()).toEqual([]);
  });

  it("does not overwrite a user's edits to a seeded archetype on reseed", async () => {
    // seeds are a starting point; once the row exists it belongs to the user,
    // and a boot-time upsert would silently revert their work
    const { createArchetypesRepo } = await import("@embedded/db");
    const repo = createArchetypesRepo(app.db);
    const before = repo.get("lora-node")!;

    const edited = { ...before, name: "My tuned LoRa node" };
    const inserted = repo.seed(edited);
    expect(inserted).toBe(false);
    expect(repo.get("lora-node")!.name).toBe(before.name);
  });
});
