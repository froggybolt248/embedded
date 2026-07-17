import { describe, expect, it } from "vitest";
import { levelShift } from "./level-shift.js";

describe("levelShift", () => {
  // The 3.3V-to-5V pair, split into its two real outcomes -- this is the
  // trap the module exists to catch. Driver: VOH=3.3V, VOL=0.1V.
  const driver = { vohV: 3.3, volV: 0.1 };

  it("passes into 5V TTL, where VIH is an absolute 2.0V spec, not VDD-relative", () => {
    // VIH=2.0V, VIL=0.8V (74LS/HCT-input parts), absoluteMaxV=5.5V (VDD+0.5)
    const r = levelShift(driver, { vihV: 2.0, vilV: 0.8, absoluteMaxV: 5.5 });
    // 3.3 - 2.0 = 1.3 V of high-side margin; 0.8 - 0.1 = 0.7 V of low-side margin
    expect(r.highMarginV).toBeCloseTo(1.3, 6);
    expect(r.lowMarginV).toBeCloseTo(0.7, 6);
    expect(r.verdict).toBe("compatible");
  });

  it("fails into 5V CMOS, where VIH = 0.7*VDD = 3.5V -- the same driver, opposite result", () => {
    // VIH=0.7*5=3.5V, VIL=0.3*5=1.5V (74HC-input parts), absoluteMaxV=5.5V
    const r = levelShift(driver, { vihV: 3.5, vilV: 1.5, absoluteMaxV: 5.5 });
    // 3.3 - 3.5 = -0.2 V: the driver's guaranteed high never reaches VIH
    expect(r.highMarginV).toBeCloseTo(-0.2, 6);
    expect(r.verdict).toBe("needs-level-shift");
  });

  it("flags a driver that can exceed the receiver's absolute maximum as damage-risk", () => {
    // A 5V driver (VOH=5.0V) into a 3.3V-rail receiver whose absolute max is
    // VDD+0.3 = 3.6V: the driver's guaranteed high alone destroys the input,
    // independent of what its VIH/VIL happen to be.
    const r = levelShift({ vohV: 5.0, volV: 0.2 }, { absoluteMaxV: 3.6 });
    expect(r.overvoltageMarginV).toBeCloseTo(-1.4, 6);
    expect(r.verdict).toBe("damage-risk");
  });

  it("reports damage-risk even when the logic thresholds are unspecified", () => {
    // Damage does not wait on knowing VIH/VIL -- an overvoltage kills the
    // input regardless of what logic level it would otherwise have read as.
    const r = levelShift(
      { vohV: 5.0, volV: 0.2 },
      { absoluteMaxV: 3.6, vihV: undefined, vilV: undefined },
    );
    expect(r.verdict).toBe("damage-risk");
  });

  it("refuses to call an unspecified receiver compatible", () => {
    // Silently treating a missing VIH/VIL as compatible is exactly the
    // confidently-wrong-number bug class this app exists to prevent.
    const r = levelShift(driver, { absoluteMaxV: 5.5 });
    expect(r.verdict).toBe("unknown");
    expect(r.reason).toMatch(/VIH/);
    expect(r.reason).toMatch(/VIL/);
  });

  it("refuses to call it compatible when only the absolute max is unspecified", () => {
    // Logic levels look fine (TTL numbers), but with no absolute-max rating
    // on file, an overvoltage cannot be ruled out -- "probably fine" is not
    // the same as "verified safe", and the two must not collapse together.
    const r = levelShift(driver, { vihV: 2.0, vilV: 0.8 });
    expect(r.verdict).toBe("unknown");
    expect(r.overvoltageMarginV).toBeNull();
  });
});
