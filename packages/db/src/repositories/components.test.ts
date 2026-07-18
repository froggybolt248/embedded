import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// EMBEDDED_DATA_DIR must be set before @embedded/db resolves the sqlite path,
// so this runs before importing the db package — same seam as
// apps/server/src/family-db.test.ts.
const dataDir = mkdtempSync(join(tmpdir(), "embedded-components-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { createDb, migrateDb, createComponentsRepo } = await import("./../index.js");
const { ComponentSpecs } = await import("@embedded/core");

/**
 * Search ranking against a REAL migrated database: parts with extracted power
 * states outrank parts with only a datasheet link, which outrank bare stubs —
 * so a search over the 22k-part KiCad dump surfaces usable parts first.
 */
describe("components list ranking", () => {
  const db = createDb(join(dataDir, "components-rank-test.db"));
  migrateDb(db);
  const repo = createComponentsRepo(db);

  afterAll(() => {
    (db as unknown as { $client: { close(): void } }).$client.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  // Inserted deliberately in worst-first order so insertion order can't fake a pass.
  const bare = repo.create({ mpn: "RANK-BARE", category: "sensor" });
  const withDatasheet = repo.create({
    mpn: "RANK-DATASHEET",
    category: "sensor",
    variantAttrs: { datasheet: "https://example.com/rank.pdf" },
  });
  const withPower = repo.create({
    mpn: "RANK-POWERSTATES",
    category: "sensor",
    specs: ComponentSpecs.parse({
      powerStates: [
        {
          name: "active",
          current: {
            typ: { value: 1, unit: "mA", source: { kind: "manual", verifiedBy: "human" } },
          },
        },
      ],
    }),
  });

  it("orders powerStates > datasheet > bare", () => {
    const mpns = repo.list({ q: "RANK-" }).map((c) => c.mpn);
    expect(mpns).toEqual([withPower.mpn, withDatasheet.mpn, bare.mpn]);
  });

  it("treats an empty powerStates array and the '~' sentinel as absent", () => {
    // explicit `powerStates: []` must not count as having power states, and
    // KiCad's "~" placeholder must not count as a datasheet link
    repo.create({
      mpn: "RANK-EMPTYISH",
      category: "sensor",
      specs: ComponentSpecs.parse({ powerStates: [] }),
      variantAttrs: { datasheet: "~" },
    });
    const mpns = repo.list({ q: "RANK-" }).map((c) => c.mpn);
    expect(mpns).toEqual([withPower.mpn, withDatasheet.mpn, bare.mpn, "RANK-EMPTYISH"]);
  });

  it("keeps pagination working over the ranked order", () => {
    const first = repo.list({ q: "RANK-", limit: 2 }).map((c) => c.mpn);
    const rest = repo.list({ q: "RANK-", limit: 2, offset: 2 }).map((c) => c.mpn);
    expect(first).toEqual([withPower.mpn, withDatasheet.mpn]);
    expect(rest).toEqual([bare.mpn, "RANK-EMPTYISH"]);
  });

  it("breaks ties within a band by shorter MPN then alphabetically", () => {
    repo.create({ mpn: "RANK-ZZ", category: "sensor" });
    repo.create({ mpn: "RANK-AA", category: "sensor" });
    const mpns = repo.list({ q: "RANK-" }).map((c) => c.mpn);
    // all three are bare (band 2): the two 7-char MPNs sort before the longer ones
    expect(mpns.slice(2)).toEqual(["RANK-AA", "RANK-ZZ", bare.mpn, "RANK-EMPTYISH"]);
  });
});
