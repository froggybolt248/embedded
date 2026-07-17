import { describe, expect, it } from "vitest";
import {
  Component,
  ComponentInterface,
  ComponentSpecs,
  CreateComponentInput,
  Pin,
  PinFunction,
} from "./component.js";

describe("PinFunction", () => {
  it("accepts every canonical value", () => {
    const canonical = [
      "supply",
      "ground",
      "i2c-sda",
      "i2c-scl",
      "i2c-address-select",
      "spi-sck",
      "spi-sdi",
      "spi-sdo",
      "spi-cs",
      "uart-tx",
      "uart-rx",
      "gpio",
      "analog-in",
      "reset",
      "interrupt",
      "nc",
    ] as const;
    for (const value of canonical) {
      expect(PinFunction.safeParse(value).success).toBe(true);
    }
  });

  it("rejects free-form prose", () => {
    expect(PinFunction.safeParse("Power supply").success).toBe(false);
    expect(PinFunction.safeParse("GND").success).toBe(false);
    expect(PinFunction.safeParse("power").success).toBe(false);
  });
});

describe("Pin.functions", () => {
  it("is deliberately lenient: accepts arbitrary strings, not just PinFunction values", () => {
    // See the comment on Pin.functions in component.ts: components committed
    // before the vocabulary existed, or hand-entered with a part-specific
    // function name, must still load. Extraction enforces the enum, not this
    // field. Do not tighten this to z.array(PinFunction) without accounting
    // for that migration story.
    const result = Pin.safeParse({ name: "PA0", functions: ["Power supply", "GND", "whatever"] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.functions).toEqual(["Power supply", "GND", "whatever"]);
    }
  });

  it("defaults functions to an empty array when omitted", () => {
    const result = Pin.safeParse({ name: "PA0" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.functions).toEqual([]);
    }
  });

  it("still rejects a functions array containing non-strings", () => {
    const result = Pin.safeParse({ name: "PA0", functions: [1, 2] });
    expect(result.success).toBe(false);
  });
});

describe("ComponentInterface", () => {
  it("defaults attrs to an empty object and accepts string/number/SourcedValue members", () => {
    const bare = ComponentInterface.safeParse({ kind: "i2c" });
    expect(bare.success).toBe(true);
    if (bare.success) expect(bare.data.attrs).toEqual({});

    const populated = ComponentInterface.safeParse({
      kind: "spi",
      attrs: {
        maxClockHz: 10_000_000,
        mode: "mode0",
        vih: { value: 2, unit: "V", source: { kind: "manual" } },
      },
    });
    expect(populated.success).toBe(true);
  });

  it("rejects an unknown interface kind", () => {
    expect(ComponentInterface.safeParse({ kind: "can-bus" }).success).toBe(false);
  });
});

describe("ComponentSpecs", () => {
  it("defaults every collection to empty when given {}", () => {
    const result = ComponentSpecs.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.absoluteMax).toEqual([]);
      expect(result.data.recommendedOperating).toEqual([]);
      expect(result.data.powerStates).toEqual([]);
      expect(result.data.pins).toEqual([]);
      expect(result.data.interfaces).toEqual([]);
      expect(result.data.decoupling).toEqual([]);
      expect(result.data.extra).toEqual({});
    }
  });
});

describe("Component", () => {
  it("parses a minimally-valid component, applying defaults for everything else", () => {
    const result = Component.safeParse({
      id: "c1",
      mpn: "ATMEGA328P",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.manufacturer).toBe("");
      expect(result.data.description).toBe("");
      expect(result.data.category).toBe("other");
      expect(result.data.lifecycle).toBe("unknown");
      expect(result.data.specs).toEqual({
        absoluteMax: [],
        recommendedOperating: [],
        powerStates: [],
        pins: [],
        interfaces: [],
        decoupling: [],
        extra: {},
      });
    }
  });

  it("requires a non-empty mpn", () => {
    const result = Component.safeParse({
      id: "c1",
      mpn: "",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });

  it("requires id, createdAt, and updatedAt (no defaults for identity/timestamps)", () => {
    expect(Component.safeParse({ mpn: "X" }).success).toBe(false);
  });

  it("rejects a category outside the canonical vocabulary", () => {
    const result = Component.safeParse({
      id: "c1",
      mpn: "X",
      category: "battery",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(result.success).toBe(false);
  });
});

describe("CreateComponentInput", () => {
  it("omits id/createdAt/updatedAt and makes manufacturer/description/category/lifecycle/specs optional", () => {
    const result = CreateComponentInput.safeParse({ mpn: "X" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("id");
      expect(result.data).not.toHaveProperty("createdAt");
      expect(result.data).not.toHaveProperty("updatedAt");
    }
  });

  it("still requires mpn", () => {
    expect(CreateComponentInput.safeParse({}).success).toBe(false);
  });
});
