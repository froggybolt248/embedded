import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// EMBEDDED_DATA_DIR must be set before @embedded/db resolves the sqlite path,
// so this runs before importing the db package — same seam as
// apps/server/src/family-db.test.ts.
const dataDir = mkdtempSync(join(tmpdir(), "embedded-grounding-states-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { createDb, migrateDb, createGroundingStatesRepo, createComponentsRepo } = await import(
  "./../index.js"
);

describe("grounding states repo", () => {
  const db = createDb(join(dataDir, "grounding-states-test.db"));
  migrateDb(db);
  const groundingStatesRepo = createGroundingStatesRepo(db);
  const componentsRepo = createComponentsRepo(db);

  const component = componentsRepo.create({ mpn: "SX1262" });

  afterAll(() => {
    (db as unknown as { $client: { close(): void } }).$client.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("returns undefined for a component with no persisted state", () => {
    expect(groundingStatesRepo.get(component.id)).toBeUndefined();
  });

  it("round-trips a state through upsert and get", () => {
    groundingStatesRepo.upsert(component.id, {
      status: "failed",
      detail: "grounding failed",
      error: "403 from vendor",
      updatedAt: "2026-07-17T00:00:00.000Z",
    });

    const fetched = groundingStatesRepo.get(component.id);
    expect(fetched).toEqual({
      componentId: component.id,
      status: "failed",
      detail: "grounding failed",
      error: "403 from vendor",
      updatedAt: "2026-07-17T00:00:00.000Z",
    });
  });

  it("upsert overwrites the previous state rather than accumulating rows", () => {
    groundingStatesRepo.upsert(component.id, {
      status: "grounded",
      detail: "grounded from datasheet",
      error: null,
      updatedAt: "2026-07-17T01:00:00.000Z",
    });

    const fetched = groundingStatesRepo.get(component.id);
    expect(fetched?.status).toBe("grounded");
    expect(fetched?.error).toBeNull();
    expect(fetched?.updatedAt).toBe("2026-07-17T01:00:00.000Z");
  });

  it("cascades delete when the owning component is removed", () => {
    const doomed = componentsRepo.create({ mpn: "TEMP-PART" });
    groundingStatesRepo.upsert(doomed.id, {
      status: "unavailable",
      detail: "no datasheet URL on this part",
      error: null,
      updatedAt: "2026-07-17T02:00:00.000Z",
    });
    expect(groundingStatesRepo.get(doomed.id)).toBeDefined();

    componentsRepo.remove(doomed.id);
    expect(groundingStatesRepo.get(doomed.id)).toBeUndefined();
  });
});
