import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const dataDir = mkdtempSync(join(tmpdir(), "embedded-calc-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

describe("calculators and runs", () => {
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

  it("creates and retrieves a calculator with JSON columns intact", async () => {
    const { createCalculatorsRepo } = await import("@embedded/db");
    const repo = createCalculatorsRepo(app.db);

    const calc = repo.create({
      id: "ignored",
      name: "Test Calculator",
      description: "A test calculator",
      inputs: [
        { name: "voltage", label: "Supply Voltage", unit: "V" },
        { name: "resistance", label: "Resistance", unit: "Ω" },
      ],
      formula: {
        current: "voltage / resistance",
        power: "voltage * voltage / resistance",
      },
      outputs: [
        { name: "current", label: "Current", unit: "A" },
        { name: "power", label: "Power", unit: "W" },
      ],
      builtin: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const retrieved = repo.get(calc.id)!;
    expect(retrieved).toBeDefined();
    expect(retrieved.name).toBe("Test Calculator");
    expect(retrieved.inputs).toHaveLength(2);
    expect(retrieved.inputs[0]!.name).toBe("voltage");
    expect(retrieved.formula).toEqual({
      current: "voltage / resistance",
      power: "voltage * voltage / resistance",
    });
    expect(retrieved.outputs).toHaveLength(2);
  });

  it("lists all calculators", async () => {
    const { createCalculatorsRepo } = await import("@embedded/db");
    const repo = createCalculatorsRepo(app.db);

    const before = repo.list();
    repo.create({
      id: "ignored",
      name: "List Test",
      description: "",
      inputs: [],
      formula: {},
      outputs: [],
      builtin: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const after = repo.list();
    expect(after.length).toBe(before.length + 1);
  });

  it("updates a calculator", async () => {
    const { createCalculatorsRepo } = await import("@embedded/db");
    const repo = createCalculatorsRepo(app.db);

    const calc = repo.create({
      id: "ignored",
      name: "Original Name",
      description: "Original",
      inputs: [{ name: "x", label: "X", unit: "unit" }],
      formula: { y: "x * 2" },
      outputs: [{ name: "y", label: "Y", unit: "unit" }],
      builtin: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const updated = repo.update(calc.id, {
      name: "Updated Name",
      description: "Updated description",
    });

    expect(updated).toBeDefined();
    expect(updated!.name).toBe("Updated Name");
    expect(updated!.description).toBe("Updated description");
    expect(updated!.inputs[0]!.name).toBe("x");
  });

  it("deletes a calculator", async () => {
    const { createCalculatorsRepo } = await import("@embedded/db");
    const repo = createCalculatorsRepo(app.db);

    const calc = repo.create({
      id: "ignored",
      name: "To Delete",
      description: "",
      inputs: [],
      formula: {},
      outputs: [],
      builtin: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const before = repo.get(calc.id);
    expect(before).toBeDefined();

    repo.delete(calc.id);
    const after = repo.get(calc.id);
    expect(after).toBeUndefined();
  });

  it("seeds a new calculator", async () => {
    const { createCalculatorsRepo } = await import("@embedded/db");
    const repo = createCalculatorsRepo(app.db);

    const seedResult = repo.seed({
      id: "seed-calc",
      name: "Seeded Calculator",
      description: "A seeded calculator",
      inputs: [],
      formula: {},
      outputs: [],
      builtin: true,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    expect(seedResult).toBe(true);
    expect(repo.get("seed-calc")).toBeDefined();
  });

  it("does not overwrite a user's edits when seeding", async () => {
    const { createCalculatorsRepo } = await import("@embedded/db");
    const repo = createCalculatorsRepo(app.db);

    const calc = repo.create({
      id: "seed-calc-existing",
      name: "User Calculator",
      description: "User's version",
      inputs: [{ name: "a", label: "A", unit: "unit" }],
      formula: { b: "a + 1" },
      outputs: [{ name: "b", label: "B", unit: "unit" }],
      builtin: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const seedResult = repo.seed({
      id: calc.id,
      name: "Seed Calculator",
      description: "Seed's version",
      inputs: [{ name: "x", label: "X", unit: "unit" }],
      formula: { y: "x * 2" },
      outputs: [{ name: "y", label: "Y", unit: "unit" }],
      builtin: true,
      createdAt: calc.createdAt,
      updatedAt: calc.updatedAt,
    });

    expect(seedResult).toBe(false);

    const retrieved = repo.get(calc.id)!;
    expect(retrieved.name).toBe("User Calculator");
    expect(retrieved.description).toBe("User's version");
  });

  it("creates and retrieves a calculator run with JSON columns intact", async () => {
    const { createCalculatorsRepo, createCalculatorRunsRepo } = await import("@embedded/db");
    const calcRepo = createCalculatorsRepo(app.db);
    const runRepo = createCalculatorRunsRepo(app.db);

    const calc = calcRepo.create({
      id: "ignored",
      name: "Test",
      description: "",
      inputs: [],
      formula: {},
      outputs: [],
      builtin: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const run = runRepo.create({
      id: "test-run-1",
      calculatorId: calc.id,
      projectId: null,
      inputs: { voltage: 5, resistance: 100 },
      outputs: { current: 0.05, power: 0.25 },
      createdAt: new Date().toISOString(),
    });

    const retrieved = runRepo.get(run.id)!;
    expect(retrieved).toBeDefined();
    expect(retrieved.inputs).toEqual({ voltage: 5, resistance: 100 });
    expect(retrieved.outputs).toEqual({ current: 0.05, power: 0.25 });
  });

  it("lists calculator runs by project", async () => {
    const { createCalculatorsRepo, createCalculatorRunsRepo, createProjectsRepo } =
      await import("@embedded/db");
    const calcRepo = createCalculatorsRepo(app.db);
    const runRepo = createCalculatorRunsRepo(app.db);
    const projRepo = createProjectsRepo(app.db);

    // Create projects first
    const proj1 = projRepo.create({ name: "Project 1", description: "" });
    const proj2 = projRepo.create({ name: "Project 2", description: "" });

    // Create a calculator
    const now = new Date().toISOString();
    const calc = calcRepo.create({
      id: "ignored",
      name: "Test",
      description: "",
      inputs: [],
      formula: {},
      outputs: [],
      builtin: false,
      createdAt: now,
      updatedAt: now,
    });

    // Create multiple runs for the same project
    runRepo.create({
      id: "ignored",
      calculatorId: calc.id,
      projectId: proj1.id,
      inputs: { x: 1 },
      outputs: { y: 2 },
      createdAt: now,
    });

    runRepo.create({
      id: "ignored",
      calculatorId: calc.id,
      projectId: proj1.id,
      inputs: { x: 3 },
      outputs: { y: 6 },
      createdAt: now,
    });

    // Create a run with different project
    const run3 = runRepo.create({
      id: "ignored",
      calculatorId: calc.id,
      projectId: proj2.id,
      inputs: { x: 5 },
      outputs: { y: 10 },
      createdAt: now,
    });

    const forProject1 = runRepo.listByProject(proj1.id);
    expect(forProject1).toHaveLength(2);
    expect(forProject1.every((r) => r.projectId === proj1.id)).toBe(true);

    const forProject2 = runRepo.listByProject(proj2.id);
    expect(forProject2).toHaveLength(1);
    expect(forProject2[0]!.id).toBe(run3.id);
  });
});
