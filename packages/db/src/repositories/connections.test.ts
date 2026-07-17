import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// EMBEDDED_DATA_DIR must be set before @embedded/db resolves the sqlite path,
// so this runs before importing the db package — same seam as
// apps/server/src/family-db.test.ts.
const dataDir = mkdtempSync(join(tmpdir(), "embedded-connections-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { createDb, migrateDb, createConnectionsRepo, createBlocksRepo, createProjectsRepo } =
  await import("./../index.js");

describe("connections repository", () => {
  const db = createDb(join(dataDir, "connections-test.db"));
  migrateDb(db);
  const connectionsRepo = createConnectionsRepo(db);
  const blocksRepo = createBlocksRepo(db);
  const projectsRepo = createProjectsRepo(db);

  const projectA = projectsRepo.create({ name: "Project A" });
  const projectB = projectsRepo.create({ name: "Project B" });

  const blockA1 = blocksRepo.create(projectA.id, { name: "MCU" });
  const blockA2 = blocksRepo.create(projectA.id, { name: "Sensor" });
  const blockB1 = blocksRepo.create(projectB.id, { name: "MCU B" });
  const blockB2 = blocksRepo.create(projectB.id, { name: "Sensor B" });

  afterAll(() => {
    (db as unknown as { $client: { close(): void } }).$client.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("round-trips a connection through create and get", () => {
    const conn = connectionsRepo.create(projectA.id, {
      fromBlockId: blockA1.id,
      toBlockId: blockA2.id,
      interface: "i2c",
    });

    expect(conn.projectId).toBe(projectA.id);
    expect(conn.fromBlockId).toBe(blockA1.id);
    expect(conn.toBlockId).toBe(blockA2.id);
    expect(conn.interface).toBe("i2c");
    expect(conn.fromPort).toBe("");
    expect(conn.toPort).toBe("");
    expect(conn.attrs).toEqual({});

    const fetched = connectionsRepo.get(conn.id);
    expect(fetched).toEqual(conn);
  });

  it("scopes listByProject so a connection in project A does not appear in project B", () => {
    const connA = connectionsRepo.create(projectA.id, {
      fromBlockId: blockA1.id,
      toBlockId: blockA2.id,
      interface: "spi",
    });
    const connB = connectionsRepo.create(projectB.id, {
      fromBlockId: blockB1.id,
      toBlockId: blockB2.id,
      interface: "uart",
    });

    const listA = connectionsRepo.listByProject(projectA.id);
    const listB = connectionsRepo.listByProject(projectB.id);

    expect(listA.some((c) => c.id === connA.id)).toBe(true);
    expect(listA.some((c) => c.id === connB.id)).toBe(false);

    expect(listB.some((c) => c.id === connB.id)).toBe(true);
    expect(listB.some((c) => c.id === connA.id)).toBe(false);
  });

  it("round-trips attrs JSON through create", () => {
    const attrs = { voltage: 3.3, busSpeedHz: 400000 };
    const conn = connectionsRepo.create(projectA.id, {
      fromBlockId: blockA1.id,
      toBlockId: blockA2.id,
      interface: "i2c",
      attrs,
    });

    expect(conn.attrs).toEqual(attrs);
    expect(connectionsRepo.get(conn.id)?.attrs).toEqual(attrs);
  });

  it("update patches only the given fields and leaves others intact", () => {
    const attrs = { voltage: 3.3, busSpeedHz: 400000 };
    const conn = connectionsRepo.create(projectA.id, {
      fromBlockId: blockA1.id,
      toBlockId: blockA2.id,
      interface: "i2c",
      fromPort: "SDA",
      toPort: "SDA",
      attrs,
    });

    const updated = connectionsRepo.update(conn.id, { toPort: "SDA2" });
    expect(updated?.toPort).toBe("SDA2");
    // everything else untouched
    expect(updated?.fromPort).toBe("SDA");
    expect(updated?.fromBlockId).toBe(blockA1.id);
    expect(updated?.toBlockId).toBe(blockA2.id);
    expect(updated?.interface).toBe("i2c");
    expect(updated?.attrs).toEqual(attrs);

    const fetched = connectionsRepo.get(conn.id);
    expect(fetched?.toPort).toBe("SDA2");
    expect(fetched?.attrs).toEqual(attrs);
  });

  it("update returns undefined for a missing id", () => {
    expect(connectionsRepo.update("does-not-exist", { toPort: "X" })).toBeUndefined();
  });

  it("removes a connection", () => {
    const conn = connectionsRepo.create(projectA.id, {
      fromBlockId: blockA1.id,
      toBlockId: blockA2.id,
      interface: "gpio",
    });
    expect(connectionsRepo.get(conn.id)).toBeDefined();

    connectionsRepo.remove(conn.id);
    expect(connectionsRepo.get(conn.id)).toBeUndefined();
  });
});
