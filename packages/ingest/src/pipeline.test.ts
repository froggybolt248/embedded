import { describe, expect, it } from "vitest";
import { mergeSection } from "./pipeline.js";
import { ExtractionFields } from "./schemas.js";

const empty = () => ExtractionFields.parse({});

const pin = (name: string, page: number) => ({ name, functions: ["supply" as const], page });

describe("mergeSection", () => {
  it("keeps a row the first time it is seen", () => {
    const fields = empty();
    mergeSection(fields, { pins: [pin("VDD", 38)] });
    expect(fields.pins).toHaveLength(1);
  });

  it("drops a row re-extracted by an overlapping section", () => {
    const fields = empty();
    mergeSection(fields, { pins: [pin("VDD", 38)] });
    mergeSection(fields, { pins: [pin("VDD", 38)] });
    expect(fields.pins).toHaveLength(1);
  });

  it("dedupes across differing provenance — same row, cited from another page", () => {
    const fields = empty();
    mergeSection(fields, { pins: [pin("VDD", 38)] });
    mergeSection(fields, { pins: [pin("VDD", 41)] });
    expect(fields.pins).toHaveLength(1);
    expect(fields.pins[0]?.page).toBe(38);
  });

  it("keeps rows that share a name but differ in value", () => {
    const fields = empty();
    const forced = (currentTyp: number) => ({
      name: "forced",
      currentTyp,
      currentMax: null,
      unit: "µA",
      page: 22,
      snippet: "forced mode current",
    });
    mergeSection(fields, { powerStates: [forced(2.8), forced(4.2)] });
    mergeSection(fields, { powerStates: [forced(2.8)] });
    expect(fields.powerStates.map((p) => p.currentTyp)).toEqual([2.8, 4.2]);
  });

  it("keeps rows that differ only in conditions", () => {
    const fields = empty();
    const row = (conditions: string) => ({
      param: "vdd",
      label: "Supply voltage",
      min: 1.71,
      typ: null,
      max: 3.6,
      unit: "V",
      conditions,
      page: 8,
      snippet: "Supply Voltage VDD 1.71 3.6 V",
    });
    mergeSection(fields, { recommendedOperating: [row("internal domains")] });
    mergeSection(fields, { recommendedOperating: [row("I/O domain")] });
    expect(fields.recommendedOperating).toHaveLength(2);
  });

  it("does not collapse interfaces that differ only inside attrs", () => {
    const fields = empty();
    const iface = (address: string) => ({
      kind: "i2c" as const,
      attrs: { address },
      page: 38,
      snippet: "I2C address",
    });
    mergeSection(fields, { interfaces: [iface("0x76")] });
    mergeSection(fields, { interfaces: [iface("0x77")] });
    expect(fields.interfaces).toHaveLength(2);
  });

  it("treats attrs written in a different key order as the same row", () => {
    const fields = empty();
    const base = { kind: "spi" as const, page: 40, snippet: "SPI" };
    mergeSection(fields, { interfaces: [{ ...base, attrs: { mode: "0", maxClockHz: 10_000_000 } }] });
    mergeSection(fields, { interfaces: [{ ...base, attrs: { maxClockHz: 10_000_000, mode: "0" } }] });
    expect(fields.interfaces).toHaveLength(1);
  });

  it("keeps the first identity and ignores later ones", () => {
    const fields = empty();
    mergeSection(fields, { identity: { mpn: "BME280", page: 13, snippet: "BME280" } });
    mergeSection(fields, { identity: { mpn: "BMP280", page: 2, snippet: "BMP280" } });
    expect(fields.identity?.mpn).toBe("BME280");
  });
});
