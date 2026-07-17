import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const dataDir = mkdtempSync(join(tmpdir(), "embedded-rules-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

describe("design rules", () => {
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

  it("creates and retrieves a design rule with JSON columns intact", async () => {
    const { createRulesRepo } = await import("@embedded/db");
    const repo = createRulesRepo(app.db);

    const now = new Date().toISOString();
    const rule = repo.create({
      id: "ignored-id-1", // create() generates a new id
      name: "Test Rule",
      description: "A test design rule",
      severity: "warning",
      appliesTo: { interface: "i2c" },
      check: {
        when: "true",
        assert: "voltage <= 5",
        message: "Voltage exceeds 5V",
      },
      enabled: true,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    });

    const retrieved = repo.get(rule.id)!;
    expect(retrieved).toBeDefined();
    expect(retrieved.name).toBe("Test Rule");
    expect(retrieved.appliesTo).toEqual({ interface: "i2c" });
    expect(retrieved.check).toEqual({
      when: "true",
      assert: "voltage <= 5",
      message: "Voltage exceeds 5V",
    });
  });

  it("lists all rules", async () => {
    const { createRulesRepo } = await import("@embedded/db");
    const repo = createRulesRepo(app.db);

    const now = new Date().toISOString();
    const before = repo.list();
    repo.create({
      id: "ignored",
      name: "List Test 1",
      description: "",
      severity: "info",
      appliesTo: {},
      check: { when: "true", assert: "true", message: "ok" },
      enabled: true,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    });

    const after = repo.list();
    expect(after.length).toBe(before.length + 1);
  });

  it("filters enabled rules", async () => {
    const { createRulesRepo } = await import("@embedded/db");
    const repo = createRulesRepo(app.db);

    const now = new Date().toISOString();
    const enabledRule = repo.create({
      id: "ignored",
      name: "Enabled Rule",
      description: "",
      severity: "warning",
      appliesTo: {},
      check: { when: "true", assert: "true", message: "ok" },
      enabled: true,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    });

    const disabledRule = repo.create({
      id: "ignored",
      name: "Disabled Rule",
      description: "",
      severity: "warning",
      appliesTo: {},
      check: { when: "true", assert: "true", message: "ok" },
      enabled: false,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    });

    const enabled = repo.listEnabled();
    const foundDisabled = enabled.find((r) => r.id === disabledRule.id);
    expect(foundDisabled).toBeUndefined();

    const all = repo.list();
    const foundInAll = all.find((r) => r.id === disabledRule.id);
    expect(foundInAll).toBeDefined();
  });

  it("updates a rule", async () => {
    const { createRulesRepo } = await import("@embedded/db");
    const repo = createRulesRepo(app.db);

    const now = new Date().toISOString();
    const rule = repo.create({
      id: "ignored",
      name: "Original Name",
      description: "Original description",
      severity: "info",
      appliesTo: {},
      check: { when: "true", assert: "true", message: "ok" },
      enabled: true,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    });

    const updated = repo.update(rule.id, {
      name: "Updated Name",
      severity: "error",
    });

    expect(updated).toBeDefined();
    expect(updated!.name).toBe("Updated Name");
    expect(updated!.severity).toBe("error");
    expect(updated!.description).toBe("Original description");
  });

  it("deletes a rule", async () => {
    const { createRulesRepo } = await import("@embedded/db");
    const repo = createRulesRepo(app.db);

    const now = new Date().toISOString();
    const rule = repo.create({
      id: "ignored",
      name: "To Delete",
      description: "",
      severity: "warning",
      appliesTo: {},
      check: { when: "true", assert: "true", message: "ok" },
      enabled: true,
      builtin: false,
      createdAt: now,
      updatedAt: now,
    });

    const before = repo.get(rule.id);
    expect(before).toBeDefined();

    repo.delete(rule.id);
    const after = repo.get(rule.id);
    expect(after).toBeUndefined();
  });

  it("does not overwrite a user's edits when seeding", async () => {
    const { createRulesRepo } = await import("@embedded/db");
    const repo = createRulesRepo(app.db);

    const rule = repo.create({
      id: "seed-test-rule",
      name: "Original Name",
      description: "Original",
      severity: "warning",
      appliesTo: {},
      check: { when: "true", assert: "true", message: "ok" },
      enabled: true,
      builtin: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Try to seed a rule with the same ID but different content
    const seedResult = repo.seed({
      id: rule.id,
      name: "Seed Name",
      description: "Seed description",
      severity: "error",
      appliesTo: { other: "field" },
      check: { when: "false", assert: "false", message: "nope" },
      enabled: false,
      builtin: true,
      createdAt: rule.createdAt,
      updatedAt: rule.updatedAt,
    });

    expect(seedResult).toBe(false);

    const retrieved = repo.get(rule.id)!;
    expect(retrieved.name).toBe("Original Name");
    expect(retrieved.description).toBe("Original");
    expect(retrieved.severity).toBe("warning");
  });

  it("seeds a new rule", async () => {
    const { createRulesRepo } = await import("@embedded/db");
    const repo = createRulesRepo(app.db);

    const seedResult = repo.seed({
      id: "fresh-seed-rule",
      name: "Seeded Rule",
      description: "A seeded rule",
      severity: "info",
      appliesTo: { test: "true" },
      check: { when: "true", assert: "true", message: "ok" },
      enabled: true,
      builtin: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(seedResult).toBe(true);
    expect(repo.get("fresh-seed-rule")).toBeDefined();
  });
});
