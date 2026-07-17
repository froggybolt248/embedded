import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// Same isolation seam as app.test.ts: EMBEDDED_DATA_DIR before importing app.js.
const dataDir = mkdtempSync(join(tmpdir(), "embedded-kicad-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");
const { importKicadDirectory } = await import("./services/kicad-import.js");
const { createComponentsRepo } = await import("@embedded/db");

/** A base sensor symbol with power/ground/I²C/NC pins. */
const BME280 = `
(kicad_symbol_lib (version 20251024) (generator "kicad_symbol_editor")
  (symbol "BME280"
    (property "Value" "BME280" (at 0 0 0))
    (property "Footprint" "Package_LGA:Bosch_LGA-8" (at 0 0 0))
    (property "Datasheet" "https://example.com/bme280.pdf" (at 0 0 0))
    (property "Description" "Humidity pressure temperature sensor" (at 0 0 0))
    (symbol "BME280_1_1"
      (pin power_in line (at 0 0 0) (name "VDD") (number "1"))
      (pin power_in line (at 0 0 0) (name "GND") (number "2"))
      (pin bidirectional line (at 0 0 0) (name "SDA") (number "5"))
      (pin input line (at 0 0 0) (name "SCL") (number "4"))
      (pin no_connect line (at 0 0 0) (name "NC") (number "6")))))
`;

/** A derived symbol: BMP280 extends BME280 (family variant, no pins of its own). */
const BMP280 = `
(kicad_symbol_lib (version 20251024) (generator "kicad_symbol_editor")
  (symbol "BMP280"
    (extends "BME280")
    (property "Value" "BMP280" (at 0 0 0))
    (property "Datasheet" "~" (at 0 0 0))
    (property "Description" "Pressure and temperature sensor" (at 0 0 0))))
`;

/**
 * A multi-unit part whose De Morgan alternate body repeats a unit's pin numbers
 * — the real quad-gate shape. Unit 1 (numbers 1,2,3) appears twice (normal +
 * demorgan); the power unit adds 7 and 14. Correct dedup keeps {1,2,3,7,14}.
 */
const GATE = `
(kicad_symbol_lib (version 20251024) (generator "kicad_symbol_editor")
  (symbol "TESTGATE"
    (property "Value" "TESTGATE" (at 0 0 0))
    (property "Description" "Test multi-unit gate" (at 0 0 0))
    (symbol "TESTGATE_1_1"
      (pin input line (at 0 0 0) (name "A") (number "1"))
      (pin input line (at 0 0 0) (name "B") (number "2"))
      (pin output line (at 0 0 0) (name "Y") (number "3")))
    (symbol "TESTGATE_1_2"
      (pin input line (at 0 0 0) (name "A") (number "1"))
      (pin input line (at 0 0 0) (name "B") (number "2"))
      (pin output line (at 0 0 0) (name "Y") (number "3")))
    (symbol "TESTGATE_2_0"
      (pin power_in line (at 0 0 0) (name "VSS") (number "7"))
      (pin power_in line (at 0 0 0) (name "VDD") (number "14")))))
`;

function writeClone(root: string): void {
  const sensor = join(root, "Sensor_Test.kicad_symdir");
  const logic = join(root, "Logic_Test.kicad_symdir");
  mkdirSync(sensor, { recursive: true });
  mkdirSync(logic, { recursive: true });
  writeFileSync(join(sensor, "BME280.kicad_sym"), BME280);
  writeFileSync(join(sensor, "BMP280.kicad_sym"), BMP280);
  writeFileSync(join(logic, "TESTGATE.kicad_sym"), GATE);
}

describe("importKicadDirectory", () => {
  let app: FastifyInstance;
  const cloneDir = mkdtempSync(join(tmpdir(), "embedded-kicad-clone-"));

  beforeAll(async () => {
    writeClone(cloneDir);
    app = buildApp();
    await app.ready();
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    rmSync(cloneDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("imports symbols, links a derived symbol to its base, and categorises by library", async () => {
    const summary = await importKicadDirectory(app.db, cloneDir);
    expect(summary.librariesProcessed).toBe(2);
    expect(summary.symbolsFound).toBe(3);
    expect(summary.created).toBe(3);
    expect(summary.variantsLinked).toBe(1);
    expect(summary.skippedDuplicates).toBe(0);

    const repo = createComponentsRepo(app.db);
    const all = repo.list();
    const bme = all.find((c) => c.mpn === "BME280")!;
    const bmp = all.find((c) => c.mpn === "BMP280")!;
    const gate = all.find((c) => c.mpn === "TESTGATE")!;

    // family link formed across two separate .kicad_sym files
    expect(bmp.familyId).toBe(bme.id);
    expect(bme.familyId).toBeNull();

    // category inferred from the library directory name
    expect(bme.category).toBe("sensor");
    expect(gate.category).toBe("other");

    // pins classified from names; datasheet URL parked for Channel 2
    expect(bme.specs.pins.find((p) => p.name === "VDD")?.functions).toEqual(["supply"]);
    expect(bme.specs.pins.find((p) => p.name === "GND")?.functions).toEqual(["ground"]);
    expect(bme.specs.pins.find((p) => p.name === "SDA")?.functions).toEqual(["i2c-sda"]);
    expect(bme.variantAttrs["datasheet"]).toContain("bme280.pdf");

    // the derived symbol inherited the base's five pins
    expect(bmp.specs.pins).toHaveLength(5);

    // De Morgan duplicates collapsed: {1,2,3,7,14}, not the raw {1,2,3,1,2,3,7,14}
    expect(gate.specs.pins.map((p) => p.number).sort()).toEqual(["1", "14", "2", "3", "7"]);
  });

  it("is idempotent — a second run creates nothing and reports the duplicates", async () => {
    const summary = await importKicadDirectory(app.db, cloneDir);
    expect(summary.created).toBe(0);
    expect(summary.skippedDuplicates).toBe(3);
    expect(createComponentsRepo(app.db).list()).toHaveLength(3);
  });

  it("honours a library filter", async () => {
    // fresh DB via a second app would be heavier; the filter's effect on
    // librariesProcessed is observable even against the now-populated library
    const summary = await importKicadDirectory(app.db, cloneDir, { libraries: ["Sensor"] });
    expect(summary.librariesProcessed).toBe(1);
  });
});
