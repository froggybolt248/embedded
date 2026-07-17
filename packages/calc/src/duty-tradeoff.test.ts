import { describe, expect, it } from "vitest";
import {
  DEFAULT_INTERVALS,
  intervalLabel,
  intervalTradeoff,
  targetUnreachable,
} from "./duty-tradeoff.js";
import type { PowerContributor } from "./power-budget.js";

const src = {
  kind: "datasheet" as const,
  datasheetId: "ds1",
  page: 8,
  snippet: "row",
  verifiedBy: "machine" as const,
};

/** A coin-cell sensor node: an MCU that wakes, a sensor that reads, a regulator
 *  that is simply always on. Currents are the shape of real grounded rows. */
function node(): PowerContributor[] {
  return [
    {
      id: "mcu",
      label: "MCU",
      sleepMa: 0.0003,
      states: [{ mode: "active", name: "IDD active", ma: 6, duty: { everySec: 60, forMs: 1000 }, source: src }],
    },
    {
      id: "sensor",
      label: "Environment sensor",
      sleepMa: 0.0001,
      states: [{ mode: "active", name: "IDD forced mode", ma: 0.714, duty: { everySec: 60, forMs: 500 }, source: src }],
    },
    {
      id: "reg",
      label: "Regulator",
      sleepMa: 0.055,
      // continuous: quiescent current costs what it costs to be switched on
      states: [{ mode: "active", name: "Quiescent Current", ma: 0.055, duty: { everySec: 1, forMs: 1000 }, source: src }],
    },
  ];
}

describe("intervalTradeoff", () => {
  it("prices each interval against the real budget, so the question is worth answering", () => {
    const options = intervalTradeoff({
      contributors: node(),
      batteryCapacityMah: 220,
      candidates: [60, 600, 3600],
    });
    expect(options.map((o) => o.label)).toEqual(["every 1 minute", "every 10 minutes", "every 1 hour"]);
    // waking less often draws less and lasts longer — monotonic, both ways
    expect(options[0]!.averageCurrentMa).toBeGreaterThan(options[1]!.averageCurrentMa);
    expect(options[1]!.averageCurrentMa).toBeGreaterThan(options[2]!.averageCurrentMa);
    expect(options[0]!.batteryLifeYears).toBeLessThan(options[1]!.batteryLifeYears);
    expect(options[1]!.batteryLifeYears).toBeLessThan(options[2]!.batteryLifeYears);
  });

  it("never rescales an always-on part by the wake interval", () => {
    // The regulator's 55 µA quiescent is continuous. If the interval touched it,
    // "wake once a day" would claim the regulator costs nothing — and a coin-cell
    // design would be told it runs essentially forever.
    const regOnly: PowerContributor[] = [node()[2] as PowerContributor];
    const options = intervalTradeoff({
      contributors: regOnly,
      batteryCapacityMah: 220,
      candidates: [60, 86_400],
    });
    expect(options[0]!.averageCurrentMa).toBeCloseTo(0.055, 6);
    expect(options[1]!.averageCurrentMa).toBeCloseTo(0.055, 6);
  });

  it("leaves the awake DURATION alone — only the cadence moves", () => {
    // forMs is (often) a datasheet fact; everySec is the design decision. A
    // trade-off that quietly shortened the wake window would be answering a
    // different question than the one asked.
    const one: PowerContributor[] = [
      {
        id: "s",
        label: "Sensor",
        sleepMa: 0,
        states: [{ mode: "active", name: "read", ma: 10, duty: { everySec: 60, forMs: 1000 }, source: src }],
      },
    ];
    // 1 s awake in 60 s = 1/60 duty * 10 mA = 0.1667 mA
    // 1 s awake in 600 s = 1/600 duty * 10 mA = 0.01667 mA — exactly 10x less
    const options = intervalTradeoff({ contributors: one, batteryCapacityMah: 220, candidates: [60, 600] });
    expect(options[0]!.averageCurrentMa).toBeCloseTo(10 / 60, 6);
    expect(options[1]!.averageCurrentMa).toBeCloseTo(10 / 600, 6);
  });

  it("says whether an option meets the target, and null when there is no target", () => {
    // 0.4 years is deliberately modest, because this node CANNOT do better than
    // ~0.45 years at any cadence: the regulator's 55 µA quiescent is continuous,
    // and 220 mAh / 0.055 mA ≈ 4000 h is a ceiling the wake interval cannot lift.
    // Waking every 10 s (~0.69 mA average) misses even that; once a day clears it.
    const withTarget = intervalTradeoff({
      contributors: node(),
      batteryCapacityMah: 220,
      candidates: [10, 86_400],
      targetLifeYears: 0.4,
    });
    expect(withTarget[0]!.meetsTarget).toBe(false);
    expect(withTarget[1]!.meetsTarget).toBe(true);
    expect(withTarget[1]!.batteryLifeYears).toBeCloseTo(0.45, 1);

    const noTarget = intervalTradeoff({ contributors: node(), batteryCapacityMah: 220, candidates: [60] });
    // "we don't know if this is good enough" is NOT "this isn't good enough"
    expect(noTarget[0]!.meetsTarget).toBeNull();
  });
});

describe("targetUnreachable", () => {
  it("spots a design no wake interval can rescue", () => {
    // The regulator alone burns 55 µA continuously — on a 220 mAh cell that is
    // ~5 months no matter how rarely anything else wakes. Asking the user to
    // keep compromising on cadence would be wasting their time: the part choice
    // is the problem.
    const options = intervalTradeoff({
      contributors: node(),
      batteryCapacityMah: 220,
      candidates: DEFAULT_INTERVALS,
      targetLifeYears: 5,
    });
    expect(targetUnreachable(options)).toBe(true);
  });

  it("is false when patience would in fact fix it", () => {
    const options = intervalTradeoff({
      contributors: node(),
      batteryCapacityMah: 220,
      candidates: DEFAULT_INTERVALS,
      targetLifeYears: 0.4,
    });
    expect(targetUnreachable(options)).toBe(false);
  });

  it("is false when there is no target to be unreachable", () => {
    const options = intervalTradeoff({ contributors: node(), batteryCapacityMah: 220, candidates: [60] });
    expect(targetUnreachable(options)).toBe(false);
  });
});

describe("intervalLabel", () => {
  it.each([
    [10, "every 10 seconds"],
    [60, "every 1 minute"],
    [300, "every 5 minutes"],
    [3600, "every 1 hour"],
    [21_600, "every 6 hours"],
    [86_400, "every 1 day"],
  ] as const)("says %i s as %s", (secs, label) => {
    expect(intervalLabel(secs)).toBe(label);
  });
});
