import { describe, expect, it } from "vitest";
import type { ComponentSpecs, PowerMode } from "@embedded/core";
import { dutyFraction, powerBudget } from "./power-budget.js";
import { currentToMa, modeCurrentsFromSpecs, sleepCurrentFromSpecs } from "./specs.js";

describe("currentToMa", () => {
  it.each([
    [5, "mA", 5],
    [2, "A", 2000],
    [340, "µA", 0.34],
    [340, "uA", 0.34],
    [100, "nA", 0.0001],
    // pdfjs splits "μA" into two runs when the mu and the A come from different
    // fonts, so rows already committed to the library carry the unit with an
    // internal space. Reading that as bare amps overstates a sleep current by a
    // millionfold — 25 µA of regulator quiescent draw would read as 25 A.
    [25, "μ A", 0.025],
  ] as const)("converts %d %s to %d mA", (value, unit, expected) => {
    expect(currentToMa(value, unit)).toBeCloseTo(expected, 9);
  });
});

const datasheetSource = (page: number) => ({
  kind: "datasheet" as const,
  datasheetId: "ds1",
  page,
  snippet: "current",
  verifiedBy: "machine" as const,
});

function specsWith(
  states: Array<{ name: string; mode?: PowerMode; typ: number; unit: string; page: number }>,
): ComponentSpecs {
  return {
    absoluteMax: [],
    recommendedOperating: [],
    powerStates: states.map((s) => ({
      name: s.name,
      ...(s.mode !== undefined ? { mode: s.mode } : {}),
      current: { typ: { value: s.typ, unit: s.unit, source: datasheetSource(s.page) } },
    })),
    pins: [],
    interfaces: [],
    decoupling: [],
    extra: {},
  } as ComponentSpecs;
}

describe("sleepCurrentFromSpecs", () => {
  it("takes the best case across sleep and standby rows, with its citation", () => {
    const sleep = sleepCurrentFromSpecs(
      specsWith([
        { name: "Sleep current", mode: "sleep", typ: 0.3, unit: "µA", page: 10 },
        { name: "Standby current", mode: "standby", typ: 0.1, unit: "µA", page: 11 },
        { name: "Supply current — measuring", mode: "active", typ: 714, unit: "µA", page: 8 },
      ]),
    )!;
    expect(sleep.ma).toBeCloseTo(0.0001, 8);
    expect(sleep.source.page).toBe(11);
  });

  it("reads the row name when a state carries no mode", () => {
    const sleep = sleepCurrentFromSpecs(specsWith([{ name: "deep sleep", typ: 0.5, unit: "µA", page: 3 }]))!;
    expect(sleep.ma).toBeCloseTo(0.0005, 8);
  });

  it("returns null rather than substituting some other small row", () => {
    // The real AP2112K regressison: its only current row is a short-circuit
    // limit. Falling back to "the lowest current on the part" made a 50 mA
    // fault rating the regulator's sleep draw and killed the whole budget.
    expect(
      sleepCurrentFromSpecs(
        specsWith([{ name: "Short Current Limit — VOUT = 0V", typ: 50, unit: "mA", page: 4 }]),
      ),
    ).toBeNull();
    expect(sleepCurrentFromSpecs(specsWith([]))).toBeNull();
  });
});

describe("dutyFraction", () => {
  it("turns 'every 60 s for 100 ms' into a fraction", () => {
    expect(dutyFraction({ everySec: 60, forMs: 100 })).toBeCloseTo(100 / 60_000, 9);
  });

  it("treats a continuous load as 100%", () => {
    expect(dutyFraction({ everySec: 1, forMs: 1000 })).toBe(1);
  });

  it("clamps rather than exceeding all of the time, and rejects nonsense", () => {
    expect(dutyFraction({ everySec: 1, forMs: 5000 })).toBe(1);
    expect(dutyFraction({ everySec: 0, forMs: 100 })).toBe(0);
    expect(dutyFraction({ everySec: 60, forMs: 0 })).toBe(0);
  });
});

describe("powerBudget", () => {
  it("gives each part its own duty and divides the battery into the total", () => {
    const result = powerBudget({
      contributors: [
        {
          id: "sensor",
          label: "BME280",
          sleepMa: 0.0001,
          states: [
            { mode: "active", name: "measuring", ma: 0.714, duty: { everySec: 60, forMs: 600 } },
          ],
        },
      ],
      batteryCapacityMah: 220,
    });

    // 600ms/60s = 1% active → 0.01*0.714 + 0.99*0.0001 = 0.007239 mA
    expect(result.averageCurrentMa).toBeCloseTo(0.007239, 6);
    expect(result.batteryLifeHours).toBeCloseTo(220 / 0.007239, 2);
    expect(result.contributions[0]!.sleepFraction).toBeCloseTo(0.99, 6);
    expect(result.contributions.reduce((s, c) => s + c.sharePct, 0)).toBeCloseTo(100, 6);
  });

  it("budgets a radio's TX burst separately from its RX window", () => {
    // The case a single system-wide duty gets wrong: TX is 120 mA but only for
    // 80 ms/min, while RX is 12 mA for 2 s/min. One shared duty would smear
    // the burst across the whole awake window and hugely overstate it.
    const [contribution] = powerBudget({
      contributors: [
        {
          id: "radio",
          label: "SX1262",
          sleepMa: 0.0012,
          states: [
            { mode: "tx", name: "TX @ +14 dBm", ma: 120, duty: { everySec: 60, forMs: 80 } },
            { mode: "rx", name: "RX", ma: 12, duty: { everySec: 60, forMs: 2000 } },
          ],
        },
      ],
      batteryCapacityMah: 3000,
    }).contributions;

    const tx = contribution!.states.find((s) => s.mode === "tx")!;
    const rx = contribution!.states.find((s) => s.mode === "rx")!;
    expect(tx.averageMa).toBeCloseTo((80 / 60_000) * 120, 9); // 0.16 mA
    expect(rx.averageMa).toBeCloseTo((2000 / 60_000) * 12, 9); // 0.4 mA
    // RX dominates TX despite TX drawing 10× the current — the whole point
    expect(rx.averageMa).toBeGreaterThan(tx.averageMa);
    expect(contribution!.averageMa).toBeCloseTo(0.16 + 0.4 + (1 - 0.0347) * 0.0012, 4);
  });

  it("keeps a continuously-powered part at full draw", () => {
    const result = powerBudget({
      contributors: [
        {
          id: "reg",
          label: "TPS63020",
          sleepMa: 0,
          states: [{ mode: "active", name: "quiescent", ma: 0.025, duty: { everySec: 1, forMs: 1000 } }],
        },
      ],
      batteryCapacityMah: 220,
    });
    expect(result.averageCurrentMa).toBeCloseTo(0.025, 9);
    expect(result.contributions[0]!.sleepFraction).toBe(0);
  });

  it("flags an over-committed part instead of returning a nonsense number", () => {
    const [c] = powerBudget({
      contributors: [
        {
          id: "x",
          label: "X",
          sleepMa: 0,
          states: [
            { mode: "tx", name: "tx", ma: 100, duty: { everySec: 1, forMs: 800 } },
            { mode: "rx", name: "rx", ma: 100, duty: { everySec: 1, forMs: 800 } },
          ],
        },
      ],
      batteryCapacityMah: 100,
    }).contributions;

    expect(c!.overCommitted).toBe(true);
    // 160% claimed → rescaled to 100%, never more than the part can physically do
    expect(c!.states.reduce((s, x) => s + x.fraction, 0)).toBeCloseTo(1, 9);
    expect(c!.averageMa).toBeCloseTo(100, 6);
  });

  it("treats an empty budget as infinite life rather than dividing by zero", () => {
    const result = powerBudget({ contributors: [], batteryCapacityMah: 220 });
    expect(result.averageCurrentMa).toBe(0);
    expect(result.batteryLifeHours).toBe(Infinity);
  });
});

describe("modeCurrentsFromSpecs", () => {
  it("keeps each awake mode separate, at its worst case", () => {
    const modes = modeCurrentsFromSpecs(
      specsWith([
        { name: "TX @ +14 dBm", mode: "tx", typ: 45, unit: "mA", page: 20 },
        { name: "TX @ +22 dBm", mode: "tx", typ: 120, unit: "mA", page: 20 },
        { name: "RX", mode: "rx", typ: 12, unit: "mA", page: 20 },
        { name: "Sleep", mode: "sleep", typ: 1.2, unit: "µA", page: 21 },
      ]),
    );
    const byMode = Object.fromEntries(modes.map((m) => [m.mode, m.ma]));
    expect(byMode["tx"]).toBeCloseTo(120, 6); // worst case, not the last row
    expect(byMode["rx"]).toBeCloseTo(12, 6);
    expect(byMode["sleep"]).toBeUndefined(); // sleep is not an awake mode
  });

  it("ignores a row that names no operating mode", () => {
    expect(
      modeCurrentsFromSpecs(
        specsWith([{ name: "Short Current Limit — VOUT = 0V", typ: 50, unit: "mA", page: 4 }]),
      ),
    ).toEqual([]);
  });
});
