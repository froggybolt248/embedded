import { describe, expect, it } from "vitest";
import { Component, ComponentSpecs, resolveSpecs } from "./component.js";

const cite = (page: number) => ({
  kind: "datasheet" as const,
  datasheetId: "ds1",
  page,
  snippet: "row",
});

const rated = (param: string, max: number) => ({
  param,
  label: param,
  range: { max: { value: max, unit: "V", bound: "max" as const, source: cite(3) } },
});

const specs = (over: Partial<ComponentSpecs> = {}): ComponentSpecs =>
  ComponentSpecs.parse(over);

describe("resolveSpecs", () => {
  it("returns a standalone component's specs untouched when it has no family", () => {
    const own = specs({ absoluteMax: [rated("vdd", 4.25)] });
    expect(resolveSpecs({ specs: own }, null)).toBe(own);
  });

  it("inherits every family row a variant does not override", () => {
    const family = { specs: specs({ absoluteMax: [rated("vdd", 4.25), rated("vio", 4.25)] }) };
    const variant = { specs: specs({}) };
    const out = resolveSpecs(variant, family);
    expect(out.absoluteMax.map((r) => r.param)).toEqual(["vdd", "vio"]);
  });

  it("lets a variant override one row while inheriting the rest", () => {
    // the real shape of a family datasheet: one shared table, a few exceptions
    const family = { specs: specs({ absoluteMax: [rated("vdd", 4.25), rated("vio", 4.25)] }) };
    const variant = { specs: specs({ absoluteMax: [rated("vdd", 6.0)] }) };
    const out = resolveSpecs(variant, family);
    expect(out.absoluteMax).toHaveLength(2);
    expect(out.absoluteMax.find((r) => r.param === "vdd")?.range.max?.value).toBe(6.0);
    expect(out.absoluteMax.find((r) => r.param === "vio")?.range.max?.value).toBe(4.25);
  });

  it("overrides power states by name and pins by name", () => {
    const family = {
      specs: specs({
        powerStates: [
          { name: "sleep", current: { typ: { value: 0.1, unit: "µA", source: cite(8) } } },
          { name: "active", current: { typ: { value: 340, unit: "µA", source: cite(8) } } },
        ],
        pins: [{ name: "VDD", functions: ["supply"] }, { name: "GND", functions: ["ground"] }],
      }),
    };
    const variant = {
      specs: specs({
        powerStates: [{ name: "sleep", current: { typ: { value: 0.05, unit: "µA", source: cite(9) } } }],
        pins: [{ name: "VDD", functions: ["supply", "analog-in"] }],
      }),
    };
    const out = resolveSpecs(variant, family);
    expect(out.powerStates.find((p) => p.name === "sleep")?.current.typ?.value).toBe(0.05);
    expect(out.powerStates.find((p) => p.name === "active")?.current.typ?.value).toBe(340);
    expect(out.pins.find((p) => p.name === "VDD")?.functions).toEqual(["supply", "analog-in"]);
    expect(out.pins.find((p) => p.name === "GND")).toBeDefined();
  });

  it("merges extra with the variant winning on key collisions", () => {
    const family = { specs: specs({ extra: { rev: { value: 1, unit: "", source: cite(1) } } }) };
    const variant = { specs: specs({ extra: { rev: { value: 2, unit: "", source: cite(2) } } }) };
    expect(resolveSpecs(variant, family).extra["rev"]?.value).toBe(2);
  });
});

describe("Component family fields", () => {
  const base = {
    id: "c1",
    mpn: "STM32F103C8T6",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };

  it("defaults a plain part to a standalone, non-family component", () => {
    const c = Component.parse(base);
    expect(c.familyId).toBeNull();
    expect(c.isFamily).toBe(false);
    expect(c.variantAttrs).toEqual({});
  });

  it("carries the ordering code and the attributes that distinguish a variant", () => {
    const c = Component.parse({
      ...base,
      familyId: "fam1",
      orderingCode: "STM32F103C8T6",
      variantAttrs: { flash: "64 KB", package: "LQFP48", tempGrade: "-40..85 °C" },
    });
    expect(c.familyId).toBe("fam1");
    expect(c.variantAttrs["package"]).toBe("LQFP48");
  });
});
