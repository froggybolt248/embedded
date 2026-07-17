import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// EMBEDDED_DATA_DIR must be set before @embedded/db resolves the sqlite path,
// so this runs before importing the db package — same seam as
// apps/server/src/family-db.test.ts.
const dataDir = mkdtempSync(join(tmpdir(), "embedded-requirements-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { createDb, migrateDb, createRequirementsRepo, createProjectsRepo } = await import(
  "./../index.js"
);

describe("requirements repo", () => {
  const db = createDb(join(dataDir, "requirements-test.db"));
  migrateDb(db);
  const requirementsRepo = createRequirementsRepo(db);
  const projectsRepo = createProjectsRepo(db);

  const project = projectsRepo.create({ name: "Requirements test project" });
  const otherProject = projectsRepo.create({ name: "Other project" });

  afterAll(() => {
    (db as unknown as { $client: { close(): void } }).$client.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("round-trips a plain requirement through create and get", () => {
    const req = requirementsRepo.create(project.id, { text: "Must survive -40C" });
    expect(req.text).toBe("Must survive -40C");
    expect(req.kind).toBe("functional");
    expect(req.status).toBe("open");
    expect(req.quantified).toBeNull();
    expect(req.createdAt).toEqual(expect.any(String));

    const fetched = requirementsRepo.get(req.id);
    expect(fetched).toEqual(req);
  });

  it("scopes listByProject to the given project", () => {
    requirementsRepo.create(project.id, { text: "Battery must last 1 year" });
    requirementsRepo.create(otherProject.id, { text: "Someone else's requirement" });

    const mine = requirementsRepo.listByProject(project.id);
    expect(mine.every((r) => r.projectId === project.id)).toBe(true);
    expect(mine.some((r) => r.text === "Someone else's requirement")).toBe(false);
  });

  it("round-trips a quantified requirement's JSON through create and get", () => {
    const quantified = { param: "avgCurrent", op: "<=" as const, value: 25, unit: "µA" };
    const req = requirementsRepo.create(project.id, {
      text: "Average current must stay low",
      kind: "power",
      quantified,
    });
    expect(req.quantified).toEqual(quantified);

    const fetched = requirementsRepo.get(req.id);
    expect(fetched?.quantified).toEqual(quantified);
  });

  it("update patches only the given fields, leaving the rest alone", () => {
    const quantified = { param: "peakCurrent", op: "<=" as const, value: 100, unit: "mA" };
    const req = requirementsRepo.create(project.id, {
      text: "Peak current bound",
      kind: "power",
      quantified,
    });

    const updated = requirementsRepo.update(req.id, { status: "met" });
    expect(updated?.status).toBe("met");
    expect(updated?.text).toBe("Peak current bound");
    expect(updated?.quantified).toEqual(quantified);

    const renamed = requirementsRepo.update(req.id, { text: "Peak current bound (revised)" });
    expect(renamed?.text).toBe("Peak current bound (revised)");
    expect(renamed?.status).toBe("met");
    expect(renamed?.quantified).toEqual(quantified);
  });

  it("removes a requirement", () => {
    const req = requirementsRepo.create(project.id, { text: "Temporary" });
    requirementsRepo.remove(req.id);
    expect(requirementsRepo.get(req.id)).toBeUndefined();
  });
});
