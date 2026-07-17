import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// EMBEDDED_DATA_DIR must be set before @embedded/db resolves the sqlite path,
// so this runs before importing the db package — same seam as
// apps/server/src/family-db.test.ts.
const dataDir = mkdtempSync(join(tmpdir(), "embedded-blocks-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { createDb, migrateDb, createBlocksRepo, createProjectsRepo } = await import("./../index.js");

/**
 * Exercises `duties` against a REAL migrated database (migration 0003 adds
 * the column), not a mocked repo — a designer's chosen duty cycle is exactly
 * the kind of decision that must actually survive a write/read round trip.
 */
describe("blocks duties persistence", () => {
  const db = createDb(join(dataDir, "blocks-duties-test.db"));
  migrateDb(db);
  const blocksRepo = createBlocksRepo(db);
  const projectsRepo = createProjectsRepo(db);

  const project = projectsRepo.create({ name: "Duty test project" });

  afterAll(() => {
    (db as unknown as { $client: { close(): void } }).$client.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("defaults duties to {} when a block is created without any", () => {
    const block = blocksRepo.create(project.id, { name: "MCU" });
    expect(block.duties).toEqual({});

    const fetched = blocksRepo.get(block.id);
    expect(fetched?.duties).toEqual({});
  });

  it("round-trips duties through create", () => {
    const duties = { active: { everySec: 60, forMs: 80 }, sleep: { everySec: 3600, forMs: 5 } };
    const block = blocksRepo.create(project.id, { name: "Radio", duties });

    expect(block.duties).toEqual(duties);
    expect(blocksRepo.get(block.id)?.duties).toEqual(duties);
  });

  it("round-trips duties through update", () => {
    const block = blocksRepo.create(project.id, { name: "Sensor" });
    expect(block.duties).toEqual({});

    const duties = { refresh: { everySec: 10, forMs: 20 } };
    const updated = blocksRepo.update(block.id, { duties });
    expect(updated?.duties).toEqual(duties);
    expect(blocksRepo.get(block.id)?.duties).toEqual(duties);

    // an update that doesn't mention duties leaves the stored value alone
    const untouched = blocksRepo.update(block.id, { name: "Sensor (renamed)" });
    expect(untouched?.duties).toEqual(duties);
  });

  it("defaults measuredMa to {} when a block is created without any", () => {
    const block = blocksRepo.create(project.id, { name: "MCU (measured)" });
    expect(block.measuredMa).toEqual({});

    const fetched = blocksRepo.get(block.id);
    expect(fetched?.measuredMa).toEqual({});
  });

  it("round-trips measuredMa through create", () => {
    const measuredMa = { active: 42.5, sleep: 0.012 };
    const block = blocksRepo.create(project.id, { name: "Radio (measured)", measuredMa });

    expect(block.measuredMa).toEqual(measuredMa);
    expect(blocksRepo.get(block.id)?.measuredMa).toEqual(measuredMa);
  });

  it("round-trips measuredMa through update", () => {
    const block = blocksRepo.create(project.id, { name: "Sensor (measured)" });
    expect(block.measuredMa).toEqual({});

    const measuredMa = { active: 18.2 };
    const updated = blocksRepo.update(block.id, { measuredMa });
    expect(updated?.measuredMa).toEqual(measuredMa);
    expect(blocksRepo.get(block.id)?.measuredMa).toEqual(measuredMa);

    // an update that doesn't mention measuredMa leaves the stored value alone
    const untouched = blocksRepo.update(block.id, { name: "Sensor (measured, renamed)" });
    expect(untouched?.measuredMa).toEqual(measuredMa);
  });

  it("reads an existing pre-migration-shaped row back as {} rather than throwing", () => {
    // Simulate a row written before `duties` existed conceptually: insert
    // directly via SQL naming every OTHER column, letting the column's own
    // NOT NULL DEFAULT '{}' (from migration 0003) backfill `duties` — exactly
    // what happens to real rows that predate the migration.
    const client = (db as unknown as { $client: { prepare(sql: string): { run(...args: unknown[]): void } } })
      .$client;
    client
      .prepare(
        `INSERT INTO blocks (id, project_id, name, role, notes, x, y) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("legacy-block-1", project.id, "Legacy block", "other", "", 0, 0);

    const fetched = blocksRepo.get("legacy-block-1");
    expect(fetched).toBeDefined();
    expect(fetched?.duties).toEqual({});
    expect(fetched?.measuredMa).toEqual({});
  });
});
