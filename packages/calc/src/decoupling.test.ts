import { describe, expect, it } from "vitest";
import { decoupling } from "./decoupling.js";
import type { ValueSource } from "@embedded/core";

describe("decoupling", () => {
  it("applies the 100 nF/pin convention when no datasheet recommendation exists", () => {
    const r = decoupling({ supplyPinCount: 4 });
    expect(r.perPinCapacitanceF).toBeCloseTo(100e-9, 12);
    // 4 pins * 100 nF = 400 nF
    expect(r.totalCeramicCapacitanceF).toBeCloseTo(400e-9, 12);
    // bulk = sqrt(1uF * 10uF) = sqrt(1e-11) = 3.1623 uF
    expect(r.bulkCapacitanceF).toBeCloseTo(3.1623e-6, 9);
    expect(r.bulkRangeF).toEqual({ minF: 1e-6, maxF: 10e-6 });
    expect(r.basis.kind).toBe("convention");
  });

  it("scales the total ceramic capacitance with the pin count, not the per-pin value", () => {
    const two = decoupling({ supplyPinCount: 2 });
    const eight = decoupling({ supplyPinCount: 8 });
    expect(two.perPinCapacitanceF).toBe(eight.perPinCapacitanceF);
    // same per-pin convention, 4x the pins -> 4x the total
    expect(eight.totalCeramicCapacitanceF).toBeCloseTo(two.totalCeramicCapacitanceF * 4, 12);
  });

  it("never attaches a ValueSource citation to the generic convention", () => {
    // A convention is not a datasheet fact. If this ever grew a fake
    // `source` field, a caller could mistake a rule of thumb for a citation
    // it does not have -- the exact bug class this app exists to prevent.
    const r = decoupling({ supplyPinCount: 4 });
    expect(r.basis.kind).toBe("convention");
    if (r.basis.kind === "convention") {
      expect(r.basis.note.length).toBeGreaterThan(0);
      expect("source" in r.basis).toBe(false);
    }
  });

  it("lets a part's own datasheet recommendation outrank the generic convention", () => {
    // e.g. a part whose datasheet explicitly calls for 220 nF/pin and 2.2 uF
    // bulk -- stronger than the generic 100 nF/1-10 uF convention, and the
    // calculator must not water it down to the generic numbers.
    const source: ValueSource = {
      kind: "datasheet",
      datasheetId: "ds-example-123",
      page: 14,
      snippet: "Decouple each VDD pin with 220 nF X7R; add 2.2 uF bulk per supply.",
    };
    const r = decoupling({
      supplyPinCount: 3,
      datasheetRecommendation: {
        perPinCapacitanceF: 220e-9,
        bulkCapacitanceF: 2.2e-6,
        source,
      },
    });
    expect(r.perPinCapacitanceF).toBeCloseTo(220e-9, 12);
    expect(r.totalCeramicCapacitanceF).toBeCloseTo(660e-9, 12);
    expect(r.bulkCapacitanceF).toBeCloseTo(2.2e-6, 12);
    expect(r.bulkRangeF).toBeNull();
    expect(r.basis).toEqual({ kind: "datasheet", source });
  });
});
