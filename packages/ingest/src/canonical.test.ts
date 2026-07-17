import { describe, expect, it } from "vitest";
import { canonicalParam, canonicalPowerState, looksLikeCurrent } from "./canonical.js";

describe("canonicalParam by symbol", () => {
  it.each([
    ["VDD", "vdd"],
    ["VDDIO", "vddio"],
    ["VIO", "vddio"],
    ["IDDSL", "iSleep"],
    ["IDDSB", "iStandby"],
    ["tstartup", "tStartup"],
    ["PSRR", "psrr"],
  ])("maps symbol %s to %s", (symbol, param) => {
    expect(canonicalParam({ symbol })).toBe(param);
  });

  it("is insensitive to case, spacing and underscores as datasheets print them", () => {
    expect(canonicalParam({ symbol: " vdd_io " })).toBe("vddio");
    expect(canonicalParam({ symbol: "V DD" })).toBe("vdd");
  });

  it("prefers the symbol over the label when both are present", () => {
    // real BME280 p8: both supply rows are labelled "Supply Voltage" and are
    // told apart only by symbol — so the symbol must win
    expect(canonicalParam({ symbol: "VDDIO", label: "Supply Voltage" })).toBe("vddio");
    expect(canonicalParam({ symbol: "VDD", label: "Supply Voltage" })).toBe("vdd");
  });
});

describe("canonicalParam by label", () => {
  it.each([
    ["Voltage at any supply pin", "vdd"],
    ["Voltage at any interface pin", "vddio"],
    ["Storage temperature", "tStorage"],
    ["Sleep current", "iSleep"],
    ["Standby current", "iStandby"],
    ["Start-up time", "tStartup"],
  ])("maps label %s to %s", (label, param) => {
    expect(canonicalParam({ label })).toBe(param);
  });

  it("distinguishes the two supply rows by their continuation text alone", () => {
    // when a family datasheet omits symbols, "Internal Domains" / "I/O Domain"
    // is the only thing separating VDD from VDDIO — this is why the merged
    // continuation label is passed in rather than just the first line
    expect(canonicalParam({ label: "Supply Voltage Internal Domains" })).toBe("vdd");
    expect(canonicalParam({ label: "Supply Voltage I/O Domain" })).toBe("vddio");
  });

  it("prefers the more specific temperature rule", () => {
    expect(canonicalParam({ label: "Storage temperature range" })).toBe("tStorage");
    expect(canonicalParam({ label: "Operating temperature range" })).toBe("tOperating");
  });

  it("returns null rather than guessing at an unrecognised row", () => {
    // an unresolved row goes to the LLM tier; a wrongly-canonicalised one
    // silently merges two different specs, which is much worse
    expect(canonicalParam({ label: "Trimming parameter NVM readout skew" })).toBeNull();
    expect(canonicalParam({ symbol: "ZZZ9" })).toBeNull();
    expect(canonicalParam({})).toBeNull();
  });
});

describe("canonicalPowerState", () => {
  it.each([
    ["Sleep current", "sleep"],
    ["Standby current (inactive period of normal mode)", "standby"],
    ["Current during humidity measurement", "active"],
    ["TX current", "tx"],
    ["RX current at 868 MHz", "rx"],
    ["Display refresh current", "refresh"],
  ])("buckets %s into mode %s", (text, mode) => {
    expect(canonicalPowerState(text)).toBe(mode);
  });

  it("returns null for text that names no operating mode", () => {
    expect(canonicalPowerState("Power supply rejection ratio")).toBeNull();
  });
});

describe("looksLikeCurrent", () => {
  it.each(["A", "mA", "µA", "μA", "uA", "nA"])("treats %s as a current unit", (unit) => {
    expect(looksLikeCurrent(unit)).toBe(true);
  });

  it.each(["V", "mV", "°C", "hPa", "kV", "%RH", "ms"])("treats %s as not a current", (unit) => {
    expect(looksLikeCurrent(unit)).toBe(false);
  });

  it("accepts both micro signs — datasheets and PDF text layers disagree", () => {
    // U+00B5 MICRO SIGN vs U+03BC GREEK SMALL LETTER MU: the BME280 text layer
    // uses both across pages for the same column
    expect(looksLikeCurrent("µA")).toBe(true);
    expect(looksLikeCurrent("μA")).toBe(true);
  });
});
