import { describe, expect, it } from "vitest";
import { ComponentSpecs, mergeSpecs, supersedeExtracted } from "./component.js";

const source = (page: number) => ({
  kind: "datasheet" as const,
  datasheetId: "ds1",
  page,
  snippet: "row",
  verifiedBy: "machine" as const,
});

/** what a bulk KiCad import produces: pins and nothing electrical */
const kicadSkeleton = ComponentSpecs.parse({
  pins: [
    { name: "VDD", number: "1", functions: ["supply"] },
    { name: "SDA", number: "2", functions: ["i2c-sda"] },
  ],
});

/** what the deterministic datasheet tier produces: electrical rows, weak pins */
const extracted = ComponentSpecs.parse({
  powerStates: [{ name: "sleep", current: { typ: { value: 0.1, unit: "µA", source: source(11) } } }],
  recommendedOperating: [
    { param: "vdd", label: "Supply voltage", range: { min: { value: 1.71, unit: "V", source: source(9) } } },
  ],
  pins: [{ name: "VDD_GARBLED", functions: [] }],
});

describe("supersedeExtracted", () => {
  const machine = (page: number) => ({
    kind: "datasheet" as const,
    datasheetId: "ds1",
    page,
    snippet: "row",
    verifiedBy: "machine" as const,
  });
  const human = (page: number) => ({ ...machine(page), verifiedBy: "human" as const });
  const otherSheet = (page: number) => ({ ...machine(page), datasheetId: "ds2" });

  it("drops the rows a previous machine read of the same datasheet left behind", () => {
    const existing = ComponentSpecs.parse({
      powerStates: [
        { name: "IDDRX — FSK 4.8 kb/s", current: { typ: { value: 4.2, unit: "mA", source: machine(16) } } },
        { name: "IDDSL", current: { typ: { value: 600, unit: "nA", source: machine(16) } } },
      ],
    });
    // the same PDF, read again by a better extractor that names its rows differently
    const reread = ComponentSpecs.parse({
      powerStates: [
        { name: "IDDRX — Receive mode — FSK 4.8 kb/s", current: { typ: { value: 8, unit: "mA", source: machine(16) } } },
      ],
    });
    const merged = mergeSpecs(supersedeExtracted(existing, "ds1"), reread);
    // without superseding, the two stale rows would survive alongside the new one
    expect(merged.powerStates).toHaveLength(1);
    expect(merged.powerStates[0]?.current.typ?.value).toBe(8);
  });

  it("never supersedes a row a human verified", () => {
    const existing = ComponentSpecs.parse({
      powerStates: [
        { name: "tx", current: { typ: { value: 120, unit: "mA", source: human(14) } } },
        { name: "rx", current: { typ: { value: 13.8, unit: "mA", source: machine(14) } } },
      ],
    });
    const kept = supersedeExtracted(existing, "ds1");
    expect(kept.powerStates.map((p) => p.name)).toEqual(["tx"]);
  });

  it("leaves rows from another datasheet and from other sources alone", () => {
    const existing = ComponentSpecs.parse({
      powerStates: [
        { name: "from-ds2", current: { typ: { value: 1, unit: "mA", source: otherSheet(3) } } },
        { name: "hand-measured", current: { typ: { value: 2, unit: "mA", source: { kind: "manual", verifiedBy: "human" } } } },
        { name: "from-ds1", current: { typ: { value: 3, unit: "mA", source: machine(3) } } },
      ],
      recommendedOperating: [
        { param: "vdd", label: "Supply voltage", range: { min: { value: 1.8, unit: "V", source: machine(9) } } },
      ],
    });
    const kept = supersedeExtracted(existing, "ds1");
    expect(kept.powerStates.map((p) => p.name)).toEqual(["from-ds2", "hand-measured"]);
    expect(kept.recommendedOperating).toHaveLength(0);
  });

  it("drops a husk row that has no numeric value and no sources — it is not evidence", () => {
    // Real-world shape: a stale PowerState surviving supersede with an empty
    // `current: {}` and no sources renders as a power state with no data
    // (e.g. the SX1262's "(NSS, MOSI, SCK) — -"). Before the fix, `superseded`
    // requires sources.length > 0, so a sourceless husk like this was never
    // superseded and survived every re-read forever.
    const existing = ComponentSpecs.parse({
      powerStates: [{ name: "placeholder", current: {} }],
    });
    expect(supersedeExtracted(existing, "ds1").powerStates).toHaveLength(0);
  });

  it("keeps a row with a real numeric value even if it is somehow missing a source", () => {
    // Defensive case: real data must never be silently dropped just because
    // it lacks sources, only because it's an empty husk. Bypass the Zod
    // schema (which normally requires a source on every SourcedValue) to
    // simulate malformed/legacy data carrying an actual number.
    const existing = {
      absoluteMax: [],
      recommendedOperating: [],
      powerStates: [
        { name: "odd", current: { typ: { value: 4.2, unit: "mA" } } },
      ],
      pins: [],
      interfaces: [],
      decoupling: [],
      extra: {},
    } as unknown as ComponentSpecs;
    expect(supersedeExtracted(existing, "ds1").powerStates).toHaveLength(1);
  });
});

describe("mergeSpecs", () => {
  it("keeps the imported pin list authoritative over a datasheet-read pinout", () => {
    const merged = mergeSpecs(kicadSkeleton, extracted);
    expect(merged.pins.map((p) => p.name)).toEqual(["VDD", "SDA"]);
  });

  it("adds the electrical layer the skeleton was missing", () => {
    const merged = mergeSpecs(kicadSkeleton, extracted);
    expect(merged.powerStates).toHaveLength(1);
    expect(merged.powerStates[0]?.name).toBe("sleep");
    expect(merged.recommendedOperating[0]?.param).toBe("vdd");
  });

  it("fills an empty pin list from the datasheet rather than leaving it empty", () => {
    const merged = mergeSpecs(ComponentSpecs.parse({}), extracted);
    expect(merged.pins.map((p) => p.name)).toEqual(["VDD_GARBLED"]);
  });

  it("overrides an existing electrical row by key but keeps unrelated ones", () => {
    const existing = ComponentSpecs.parse({
      powerStates: [
        { name: "sleep", current: { typ: { value: 9, unit: "µA", source: source(1) } } },
        { name: "measured-tx", current: { typ: { value: 12, unit: "mA", source: source(2) } } },
      ],
    });
    const merged = mergeSpecs(existing, extracted);
    const byName = Object.fromEntries(merged.powerStates.map((s) => [s.name, s.current.typ?.value]));
    expect(byName["sleep"]).toBe(0.1); // datasheet wins for the row it has
    expect(byName["measured-tx"]).toBe(12); // untouched
  });
});
