import { describe, expect, it } from "vitest";
import { findNumericClaims, ungroundedClaims, type GroundedClaim } from "./grounding.js";

describe("findNumericClaims", () => {
  it("finds numbers with engineering units", () => {
    const text = "Use a 4.7 kΩ pull-up at 400 kHz on the 3.3 V rail drawing 12 µA.";
    const matches = findNumericClaims(text).map((f) => f.match);
    expect(matches).toContain("4.7 kΩ");
    expect(matches).toContain("400 kHz");
    expect(matches).toContain("3.3 V");
    expect(matches).toContain("12 µA");
  });

  it("ignores bare numbers without units", () => {
    expect(findNumericClaims("There are 3 sensors and 12 pins.")).toHaveLength(0);
  });
});

describe("ungroundedClaims", () => {
  it("flags value-bearing claims without citations and passes cited ones", () => {
    const claims: GroundedClaim[] = [
      {
        claim: "sleep current is 0.1 µA",
        value: 0.1,
        unit: "µA",
        citation: { kind: "datasheet", datasheetId: "ds1", page: 12 },
      },
      { claim: "supply voltage is 1.8 V", value: 1.8, unit: "V" },
      { claim: "it supports I2C" },
    ];
    const flagged = ungroundedClaims(claims);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.claim).toMatch(/1.8 V/);
  });
});
