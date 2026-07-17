import { describe, expect, it } from "vitest";
import { fieldsToSpecs } from "./commit.js";
import { ExtractionFields } from "./schemas.js";

const row = (extractor: "deterministic" | "llm" | undefined) =>
  ExtractionFields.parse({
    absoluteMax: [
      {
        param: "vdd",
        label: "Voltage at any supply pin",
        min: -0.3,
        typ: null,
        max: 4.25,
        unit: "V",
        page: 13,
        snippet: "Voltage at any supply pin VDD and VDDIO pin -0.3 4.25",
        ...(extractor !== undefined ? { extractor } : {}),
      },
    ],
  });

const maxSourceOf = (fields: ExtractionFields) =>
  fieldsToSpecs(fields, "ds1", { verified: false }).absoluteMax[0]?.range.max?.source;

/**
 * The trust ladder is what makes bulk ingest safe: without it, either every
 * datasheet needs hand review (and mass processing is impossible) or every
 * LLM-transcribed number is trusted (and a fabricated citation reaches the
 * calculators). These tests pin the distinction.
 */
describe("fieldsToSpecs trust ladder", () => {
  it("marks a deterministically-parsed row machine-verified without human review", () => {
    expect(maxSourceOf(row("deterministic"))?.verifiedBy).toBe("machine");
  });

  it("leaves an LLM-transcribed row unverified without human review", () => {
    expect(maxSourceOf(row("llm"))?.verifiedBy).toBeUndefined();
  });

  it("treats an unmarked row as LLM output — the conservative reading", () => {
    // rows written before the deterministic tier existed carry no extractor
    expect(maxSourceOf(row(undefined))?.verifiedBy).toBeUndefined();
  });

  it("stamps human on everything a person accepted, whatever produced it", () => {
    for (const extractor of ["deterministic", "llm", undefined] as const) {
      const specs = fieldsToSpecs(row(extractor), "ds1", { verified: true });
      expect(specs.absoluteMax[0]?.range.max?.source.verifiedBy).toBe("human");
    }
  });

  it("still cites page and snippet on a machine-verified value", () => {
    // auto-accepted must never mean unauditable
    const source = maxSourceOf(row("deterministic"));
    expect(source?.kind).toBe("datasheet");
    expect(source?.page).toBe(13);
    expect(source?.snippet).toContain("4.25");
    expect(source?.datasheetId).toBe("ds1");
  });
});
