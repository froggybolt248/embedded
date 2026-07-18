import { describe, expect, it } from "vitest";
import type { Pin } from "./component.js";
import { assignPinSides } from "./schematic.js";

function pin(overrides: Partial<Pin> & { name: string }): Pin {
  return { functions: [], ...overrides };
}

describe("assignPinSides", () => {
  it("puts a supply-function pin on top", () => {
    const [p] = assignPinSides([pin({ name: "P1", functions: ["supply"] })]);
    expect(p!.side).toBe("top");
  });

  it("puts a pin matching the VDD/VCC/VBAT/AVDD/VIN/VS name convention on top even with no supply function", () => {
    for (const name of ["VDD", "VCC", "VBAT", "AVDD", "VIN", "VS", "vdd_io"]) {
      const [p] = assignPinSides([pin({ name })]);
      expect(p!.side).toBe("top");
    }
  });

  it("puts a ground-function pin on bottom", () => {
    const [p] = assignPinSides([pin({ name: "P1", functions: ["ground"] })]);
    expect(p!.side).toBe("bottom");
  });

  it("puts a pin matching the GND/VSS/AGND/DGND/EP/PAD name convention on bottom, including the thermal pad", () => {
    for (const name of ["GND", "VSS", "AGND", "DGND", "EP", "PAD"]) {
      const [p] = assignPinSides([pin({ name })]);
      expect(p!.side).toBe("bottom");
    }
  });

  it("puts reset, interrupt, i2c-address-select and analog-in on the left", () => {
    for (const fn of ["reset", "interrupt", "i2c-address-select", "analog-in"]) {
      const [p] = assignPinSides([pin({ name: "P1", functions: [fn] })]);
      expect(p!.side).toBe("left");
    }
  });

  it("puts bus/data functions and unrecognised functions on the right", () => {
    for (const fn of ["i2c-sda", "i2c-scl", "spi-sck", "spi-sdi", "spi-sdo", "spi-cs", "uart-tx", "uart-rx", "gpio", "nc", "something-unknown"]) {
      const [p] = assignPinSides([pin({ name: "P1", functions: [fn] })]);
      expect(p!.side).toBe("right");
    }
  });

  it("orders a side numerically by pin number when every pin on that side is numeric", () => {
    const pins = assignPinSides([
      pin({ name: "SDA", number: "3", functions: ["i2c-sda"] }),
      pin({ name: "SCL", number: "1", functions: ["i2c-scl"] }),
      pin({ name: "GPIO0", number: "2", functions: ["gpio"] }),
    ]);
    const right = pins.filter((p) => p.side === "right");
    expect(right.map((p) => p.name)).toEqual(["SCL", "GPIO0", "SDA"]);
    expect(right.map((p) => p.index)).toEqual([0, 1, 2]);
  });

  it("falls back to alphabetical-by-name ordering when any pin on the side has no numeric number", () => {
    const pins = assignPinSides([
      pin({ name: "SDA", number: "3", functions: ["i2c-sda"] }),
      pin({ name: "SCL", functions: ["i2c-scl"] }), // no number at all
      pin({ name: "GPIO0", number: "A2", functions: ["gpio"] }), // non-numeric number
    ]);
    const right = pins.filter((p) => p.side === "right");
    // alphabetical: GPIO0 < SCL < SDA
    expect(right.map((p) => p.name)).toEqual(["GPIO0", "SCL", "SDA"]);
  });

  it("indexes each side independently, starting at 0", () => {
    const pins = assignPinSides([
      pin({ name: "VDD", functions: ["supply"] }),
      pin({ name: "GND", functions: ["ground"] }),
      pin({ name: "RESET", functions: ["reset"] }),
      pin({ name: "SDA", functions: ["i2c-sda"] }),
    ]);
    for (const p of pins) expect(p.index).toBe(0);
  });

  it("carries name, number, and functions through unchanged", () => {
    const [p] = assignPinSides([pin({ name: "SDA", number: "7", functions: ["i2c-sda", "gpio"] })]);
    expect(p).toMatchObject({ name: "SDA", number: "7", functions: ["i2c-sda", "gpio"], side: "right" });
  });

  it("omits `number` entirely (not undefined) when the pin has none — exactOptionalPropertyTypes", () => {
    const [p] = assignPinSides([pin({ name: "SDA", functions: ["i2c-sda"] })]);
    expect("number" in p!).toBe(false);
  });

  it("returns an empty array for an empty pin list", () => {
    expect(assignPinSides([])).toEqual([]);
  });
});
