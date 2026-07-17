import { describe, expect, it } from "vitest";
import { loadSwitch } from "./load-switch.js";

describe("loadSwitch", () => {
  it("computes conduction loss and a comfortable thermal margin with adequate gate drive", () => {
    // Logic-level FET quoted 30 mOhm @ Vgs=4.5V, driven from a 5V rail: adequate.
    // P = I^2*R = 2^2 * 0.03 = 0.12 W. Rise = 0.12 * 50 = 6 C. Tj = 25+6 = 31 C.
    const r = loadSwitch({
      loadCurrentA: 2,
      rdsOnOhms: 0.03,
      gateTestVgsV: 4.5,
      gateDriveVgsV: 5,
      rThetaJaCPerW: 50,
      ambientTempC: 25,
      maxJunctionTempC: 150,
    });
    expect(r.gateDriveAdequate).toBe(true);
    expect(r.conductionLossAtQuotedRdsOnW).toBeCloseTo(0.12, 6);
    expect(r.junctionTempRiseAtQuotedRdsOnC).toBeCloseTo(6, 6);
    expect(r.junctionTempAtQuotedRdsOnC).toBeCloseTo(31, 6);
    expect(r.thermalVerdict).toBe("ok");
  });

  it("treats Vgs equal to the datasheet's test point as adequate (boundary, not strict)", () => {
    const r = loadSwitch({
      loadCurrentA: 1,
      rdsOnOhms: 0.05,
      gateTestVgsV: 4.5,
      gateDriveVgsV: 4.5,
      rThetaJaCPerW: 40,
      ambientTempC: 25,
      maxJunctionTempC: 150,
    });
    expect(r.gateDriveAdequate).toBe(true);
  });

  it("catches the classic trap: a FET quoted at Vgs=10V driven from a 3.3V GPIO", () => {
    // e.g. an IRF540N-class part: 44 mOhm @ Vgs=10V, but this design's gate
    // drive is 3.3V -- the quoted 44 mOhm is not achieved, and the real
    // Rds(on) at 3.3V is unspecified (and much higher) without the part's
    // Vgs-vs-Rds(on) curve, which this calculator is not given.
    // Floor: P = 2^2*0.044 = 0.176 W, rise = 0.176*62 = 10.912 C, Tj = 35.912 C
    // -- comfortably under 150 C, but that comfort is not trustworthy, because
    // the real Rds(on) (and so the real Tj) is higher than this floor.
    const r = loadSwitch({
      loadCurrentA: 2,
      rdsOnOhms: 0.044,
      gateTestVgsV: 10,
      gateDriveVgsV: 3.3,
      rThetaJaCPerW: 62,
      ambientTempC: 25,
      maxJunctionTempC: 150,
    });
    expect(r.gateDriveAdequate).toBe(false);
    expect(r.junctionTempAtQuotedRdsOnC).toBeCloseTo(35.912, 3);
    // NOT "ok" -- the calculator must not claim safety it cannot back up
    expect(r.thermalVerdict).toBe("unknown");
  });

  it("still reports exceeds when the floor computation alone blows the budget", () => {
    // Same underdriven part, but a heavier 20 A load: even the optimistic
    // floor now exceeds Tmax, so the real (higher-Rds(on)) case is worse
    // still. This verdict does not need the gate drive to be adequate to be
    // trustworthy -- power and temperature only go up from here.
    // P = 20^2*0.044 = 17.6 W, rise = 17.6*62 = 1091.2 C, Tj = 1116.2 C
    const r = loadSwitch({
      loadCurrentA: 20,
      rdsOnOhms: 0.044,
      gateTestVgsV: 10,
      gateDriveVgsV: 3.3,
      rThetaJaCPerW: 62,
      ambientTempC: 25,
      maxJunctionTempC: 150,
    });
    expect(r.gateDriveAdequate).toBe(false);
    expect(r.junctionTempAtQuotedRdsOnC).toBeGreaterThan(150);
    expect(r.thermalVerdict).toBe("exceeds");
  });
});
