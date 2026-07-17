import { describe, expect, it } from "vitest";
import { pulsedLoad } from "./bulk-cap.js";

describe("pulsedLoad", () => {
  // The signature coin-cell failure. A CR2032 (~10 Ω fresh) asked for the
  // SX1262's 120 mA transmit burst sags 1.2 V on the spot — from 3.0 V to 1.8 V,
  // straight through an nRF52840's 1.7 V brownout on a cold or aged cell. The
  // power budget says the average is microamps and everything is fine.
  it("catches the coin-cell LoRa transmit brownout a budget cannot see", () => {
    const r = pulsedLoad({
      supplyV: 3.0,
      sourceResistanceOhms: 10,
      pulseCurrentA: 0.12,
      pulseDurationS: 0.08,
      minAcceptableV: 2.0,
    });
    expect(r.sagV).toBeCloseTo(1.2, 6);
    expect(r.saggedRailV).toBeCloseTo(1.8, 6);
    expect(r.adequateWithoutCap).toBe(false);
    // C = 0.12 A * 0.08 s / 1.0 V = 9.6 mF — a supercap, not a ceramic. The
    // number is meant to be alarming: it is why coin-cell LoRa nodes lower TX
    // power or use a different cell, and the calculator should say so plainly.
    expect(r.requiredCapacitanceF).toBeCloseTo(9.6e-3, 6);
  });

  it("reports no capacitor needed when the source is stiff enough on its own", () => {
    const r = pulsedLoad({
      supplyV: 3.3,
      sourceResistanceOhms: 0.1,
      pulseCurrentA: 0.12,
      pulseDurationS: 0.08,
      minAcceptableV: 3.0,
    });
    expect(r.sagV).toBeCloseTo(0.012, 6);
    expect(r.adequateWithoutCap).toBe(true);
    expect(r.requiredCapacitanceF).toBe(0);
    expect(r.rechargeTimeS).toBeNull();
  });

  it("sizes an e-ink refresh burst against a soft rail", () => {
    // 2.13" e-ink refresh: ~20 mA for 2 s through 30 Ω sags 0.6 V, taking a
    // 3.3 V rail to 2.7 V — below a 2.9 V floor. C = 0.02 * 2 / 0.4 = 100 mF.
    // The long burst is what makes this expensive: charge is current × TIME.
    const r = pulsedLoad({
      supplyV: 3.3,
      sourceResistanceOhms: 30,
      pulseCurrentA: 0.02,
      pulseDurationS: 2,
      minAcceptableV: 2.9,
    });
    expect(r.sagV).toBeCloseTo(0.6, 6);
    expect(r.saggedRailV).toBeCloseTo(2.7, 6);
    expect(r.adequateWithoutCap).toBe(false);
    expect(r.requiredCapacitanceF).toBeCloseTo(0.1, 6);
  });

  it("scales the capacitor with the charge the burst moves", () => {
    const base = { supplyV: 3.0, sourceResistanceOhms: 10, minAcceptableV: 2.0 };
    const short = pulsedLoad({ ...base, pulseCurrentA: 0.12, pulseDurationS: 0.04 });
    const long = pulsedLoad({ ...base, pulseCurrentA: 0.12, pulseDurationS: 0.08 });
    // twice the burst, twice the charge, twice the capacitor
    expect((long.requiredCapacitanceF as number) / (short.requiredCapacitanceF as number)).toBeCloseTo(2, 6);
  });

  it("reports the recharge time, so a fast repeat cannot be missed", () => {
    const r = pulsedLoad({
      supplyV: 3.0,
      sourceResistanceOhms: 10,
      pulseCurrentA: 0.12,
      pulseDurationS: 0.08,
      minAcceptableV: 2.0,
    });
    // 5 * 10 Ω * 9.6 mF = 0.48 s. Comfortable for a node transmitting every
    // 60 s; NOT comfortable for a burst repeating every 100 ms, which is the
    // case this number exists to expose.
    expect(r.rechargeTimeS).toBeCloseTo(0.48, 6);
    expect(r.rechargeTimeS as number).toBeLessThan(60);
    expect(r.rechargeTimeS as number).toBeGreaterThan(0.1);
  });

  it("reports a rail with no droop budget as hopeless rather than sizing a capacitor", () => {
    // 3.3 V rail, parts need 3.3 V: there is no room to droop at all, and no
    // capacitor can create headroom that does not exist
    const r = pulsedLoad({
      supplyV: 3.3,
      sourceResistanceOhms: 1,
      pulseCurrentA: 0.05,
      pulseDurationS: 0.01,
      minAcceptableV: 3.3,
    });
    expect(r.hopeless).toBe(true);
    expect(r.requiredCapacitanceF).toBeNull();
  });

  it("shows a depleted cell failing where a fresh one passed", () => {
    // same design, same burst — only the cell's internal resistance aged
    const design = { supplyV: 3.0, pulseCurrentA: 0.02, pulseDurationS: 0.05, minAcceptableV: 2.4 };
    const fresh = pulsedLoad({ ...design, sourceResistanceOhms: 10 });
    const aged = pulsedLoad({ ...design, sourceResistanceOhms: 100 });
    expect(fresh.adequateWithoutCap).toBe(true);
    expect(aged.adequateWithoutCap).toBe(false);
  });
});
