import { describe, expect, it } from "vitest";
import { i2cModeForSpeed, i2cPullup } from "./i2c-pullup.js";

describe("i2cPullup", () => {
  // The plan's stated acceptance fixture, hand-computed from UM10204:
  //   Rmin = (3.3 - 0.4) / 3 mA           = 966.7 Ω
  //   Rmax = 300 ns / (0.8473 * 200 pF)   = 1770.3 Ω
  it("reproduces the hand-computed 3.3 V / 400 kHz / 200 pF window", () => {
    const r = i2cPullup({ vddV: 3.3, busCapacitanceF: 200e-12, mode: "fast" });
    expect(r.minOhms).toBeCloseTo(966.67, 1);
    expect(r.maxOhms).toBeCloseTo(1770.3, 1);
    expect(r.impossible).toBe(false);
    // the recommendation sits inside the window, at neither edge
    expect(r.recommendedOhms).toBeGreaterThan(r.minOhms);
    expect(r.recommendedOhms).toBeLessThan(r.maxOhms);
  });

  it("shows why the copied-everywhere 4.7 kΩ is out of spec at 400 kHz", () => {
    const r = i2cPullup({ vddV: 3.3, busCapacitanceF: 200e-12, mode: "fast" });
    expect(4700).toBeGreaterThan(r.maxOhms); // too weak: rise time blows the budget
  });

  it("accepts 4.7 kΩ at 100 kHz, where it really is fine", () => {
    const r = i2cPullup({ vddV: 3.3, busCapacitanceF: 200e-12, mode: "standard" });
    expect(4700).toBeGreaterThan(r.minOhms);
    expect(4700).toBeLessThan(r.maxOhms);
  });

  it("reports an impossible bus instead of inventing a resistor for it", () => {
    // 400 kHz into 600 pF: no resistor is both strong enough to meet the rise
    // budget and weak enough for a 3 mA sink. The honest answer is "you cannot".
    const r = i2cPullup({ vddV: 3.3, busCapacitanceF: 600e-12, mode: "fast" });
    expect(r.impossible).toBe(true);
    expect(r.maxOhms).toBeLessThan(r.minOhms);
  });

  it("lets fast-mode-plus use a stronger pull-up, via its 20 mA IOL", () => {
    const fast = i2cPullup({ vddV: 3.3, busCapacitanceF: 200e-12, mode: "fast" });
    const plus = i2cPullup({ vddV: 3.3, busCapacitanceF: 200e-12, mode: "fast-plus" });
    expect(plus.minOhms).toBeLessThan(fast.minOhms);
    expect(plus.impossible).toBe(false);
  });

  it("scales the low-side bound with VDD", () => {
    const v18 = i2cPullup({ vddV: 1.8, busCapacitanceF: 100e-12, mode: "fast" });
    const v33 = i2cPullup({ vddV: 3.3, busCapacitanceF: 100e-12, mode: "fast" });
    expect(v18.minOhms).toBeCloseTo((1.8 - 0.4) / 0.003, 1);
    expect(v18.minOhms).toBeLessThan(v33.minOhms);
    // rise-time ceiling depends only on capacitance, not supply
    expect(v18.maxOhms).toBeCloseTo(v33.maxOhms, 6);
  });

  it("honours a driver's own VOL rather than assuming 0.4 V", () => {
    const r = i2cPullup({ vddV: 3.3, busCapacitanceF: 200e-12, mode: "fast", volV: 0.2 });
    expect(r.minOhms).toBeCloseTo((3.3 - 0.2) / 0.003, 1);
  });
});

describe("i2cModeForSpeed", () => {
  it.each([
    [100_000, "standard"],
    [400_000, "fast"],
    [1_000_000, "fast-plus"],
    [50_000, "standard"],
  ] as const)("reads %i Hz as %s", (hz, mode) => {
    expect(i2cModeForSpeed(hz)).toBe(mode);
  });

  it("treats a speed just over a boundary as the faster mode's problem", () => {
    // 100 kHz exactly is standard; anything above it must meet fast-mode rise times
    expect(i2cModeForSpeed(100_001)).toBe("fast");
  });
});
