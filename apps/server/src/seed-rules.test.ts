import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { createRulesRepo } from "@embedded/db";

const dataDir = mkdtempSync(join(tmpdir(), "embedded-seed-rules-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");
const { seedRules } = await import("./services/seed.js");

describe("seedRules", () => {
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

  it("seeds all 8 rules from the real seeds/rules.json", () => {
    const repo = createRulesRepo(app.db);
    const rules = repo.list();
    expect(rules).toHaveLength(8);
    expect(rules.some((r) => r.id === "i2c-pullup-too-weak")).toBe(true);
    expect(rules.some((r) => r.id === "i2c-pullup-too-strong")).toBe(true);
    expect(rules.some((r) => r.id === "level-shift-overvoltage")).toBe(true);
    expect(rules.some((r) => r.id === "level-shift-weak-high")).toBe(true);
    expect(rules.some((r) => r.id === "rail-exceeds-abs-max")).toBe(true);
    expect(rules.some((r) => r.id === "rail-below-recommended-min")).toBe(true);
    expect(rules.some((r) => r.id === "battery-life-below-target")).toBe(true);
    expect(rules.some((r) => r.id === "part-is-end-of-life")).toBe(true);
  });

  it("is idempotent — second call creates 0, and total rule count stays 8", () => {
    // The app already called seedRules on boot, so we already have 8.
    // Calling it again should return 0 (no new rows created).
    const created = seedRules(app.db);
    expect(created).toBe(0);

    // Verify the total is still 8
    const repo = createRulesRepo(app.db);
    const rules = repo.list();
    expect(rules).toHaveLength(8);
  });

  it("returns 0 rather than throwing when pointed at a directory with no rules.json", () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "embedded-seed-no-rules-"));
    try {
      const created = seedRules(app.db, emptyDir);
      expect(created).toBe(0);
    } finally {
      rmSync(emptyDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });

  it("a seeded rule round-trips with its citation and severity intact", () => {
    const repo = createRulesRepo(app.db);
    const rule = repo.get("i2c-pullup-too-weak");

    expect(rule).toBeDefined();
    expect(rule?.id).toBe("i2c-pullup-too-weak");
    expect(rule?.name).toBe("I²C pull-up too weak for the bus speed");
    expect(rule?.severity).toBe("warning");
    expect(rule?.citation).toBe(
      "NXP UM10204 (I²C-bus specification and user manual), §7.1 and Table 10"
    );
  });
});
