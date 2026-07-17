import { describe, expect, it } from "vitest";
import type { OutlineEntry } from "./pdf.js";
import { triageFromOutline, triageFromText } from "./triage.js";

/**
 * The real BME280 outline, captured verbatim from the actual PDF via
 * LoadedPdf.outline() (60 pages). Subsections that don't affect page
 * boundaries for the asserted pages are elided.
 */
const BME280_OUTLINE: OutlineEntry[] = [
  { title: "1. Specification", page: 8, depth: 0 },
  { title: "1.1 General electrical specification", page: 8, depth: 1 },
  { title: "1.2 Humidity parameter specification", page: 9, depth: 1 },
  { title: "1.3 Pressure sensor specification", page: 10, depth: 1 },
  { title: "1.4 Temperature sensor specification", page: 11, depth: 1 },
  { title: "2. Absolute maximum ratings", page: 13, depth: 0 },
  { title: "3. Functional description", page: 14, depth: 0 },
  { title: "3.2 Power management", page: 14, depth: 1 },
  { title: "3.6 Noise", page: 21, depth: 1 },
  { title: "4. Data readout", page: 23, depth: 0 },
  { title: "5. Global memory map and register description", page: 26, depth: 0 },
  { title: "6. Digital interfaces", page: 32, depth: 0 },
  { title: "6.4 Interface parameter specification", page: 35, depth: 1 },
  { title: "7. Pin-out and connection diagram", page: 38, depth: 0 },
  { title: "7.1 Pin-out", page: 38, depth: 1 },
  { title: "7.2 Connection diagram I2C", page: 39, depth: 1 },
  { title: "7.5 Package dimensions", page: 42, depth: 1 },
  { title: "8. Appendix A: Alternative compensation formulas", page: 49, depth: 0 },
  { title: "9. Appendix B: Measurement time and current calculation", page: 51, depth: 0 },
  { title: "9.5 Current consumption", page: 52, depth: 1 },
  { title: "10. Self test", page: 53, depth: 0 },
  { title: "11. Legal disclaimer", page: 58, depth: 0 },
  { title: "12. Document history and modification", page: 59, depth: 0 },
];

describe("triageFromOutline on the real BME280 outline", () => {
  const triage = triageFromOutline(BME280_OUTLINE, 60);

  it("classifies with source 'outline' and no unclassified pages", () => {
    expect(triage).not.toBeNull();
    expect(triage?.source).toBe("outline");
    expect(triage?.unclassified).toEqual([]);
  });

  it.each([
    [8, "electrical-characteristics"],
    [13, "absolute-max"],
    [38, "pinout"],
    [39, "application"],
    [42, "package"],
    [52, "power"],
    [26, "other"],
    [58, "other"],
  ] as const)("classifies p%i as %s", (page, section) => {
    expect(triage?.sectionMap[String(page)]).toBe(section);
  });

  it("carries a section through its span (specification chapter covers p9–12)", () => {
    for (const p of [9, 10, 11, 12]) {
      expect(triage?.sectionMap[String(p)]).toBe("electrical-characteristics");
    }
  });

  it("classifies the leading cover/TOC pages as other", () => {
    for (const p of [1, 2, 7]) {
      expect(triage?.sectionMap[String(p)]).toBe("other");
    }
  });

  it("lets the higher-priority section win a shared start page (p14 power over other)", () => {
    // "3. Functional description" (other) and "3.2 Power management" (power) both start p14
    expect(triage?.sectionMap["14"]).toBe("power");
  });

  it("covers every page of the document", () => {
    for (let p = 1; p <= 60; p++) {
      expect(triage?.sectionMap[String(p)]).toBeDefined();
    }
  });
});

describe("triageFromOutline rejects untrustworthy outlines", () => {
  it("returns null for an empty outline", () => {
    expect(triageFromOutline([], 60)).toBeNull();
  });

  it("returns null for a sparse outline (2 bookmarks for 60 pages)", () => {
    const sparse: OutlineEntry[] = [
      { title: "Introduction", page: 1, depth: 0 },
      { title: "Specifications", page: 5, depth: 0 },
    ];
    expect(triageFromOutline(sparse, 60)).toBeNull();
  });
});

describe("triageFromText", () => {
  it("classifies a page opening with a strong heading", () => {
    const result = triageFromText([
      {
        page: 13,
        text: "Absolute maximum ratings The absolute maximum ratings are provided in Table 3. Parameter Condition Min Max Unit Voltage at any supply pin -0.3 4.25 V",
      },
    ]);
    expect(result.sectionMap["13"]).toBe("absolute-max");
    expect(result.unclassified).toEqual([]);
    expect(result.source).toBe("keywords");
  });

  it("leaves a page with no header signal to the LLM instead of guessing", () => {
    const result = triageFromText([
      { page: 30, text: "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod." },
    ]);
    expect(result.sectionMap["30"]).toBeUndefined();
    expect(result.unclassified).toEqual([30]);
  });

  /**
   * Verbatim-shaped TOC text from the corpus of 11 real vendor datasheets,
   * where naive phrase matching put the table of contents at 6 of 8 "absolute
   * maximum" hits. A TOC names every section, so it matches every rule at once.
   */
  it.each([
    ["bmp280 (numbered entries + leader dots)", "Index of Contents 1. Specification .... 5 2. Absolute maximum ratings ....9 3. Functional description ....14"],
    ["TI house style", "Table of Contents 1 Features .......... 1 6 Specifications .......... 4 6.1 Absolute Maximum Ratings .......... 4"],
    ["ST house style with spaced leaders", "STM32F103x8 Contents 5 Electrical characteristics . . . . . . . . . . 35 5.2 Absolute maximum ratings . . . . . . . 36"],
  ])("classifies a %s TOC as other, never as the section it lists", (_name, text) => {
    const result = triageFromText([{ page: 2, text }]);
    expect(result.sectionMap["2"]).toBe("other");
    expect(result.unclassified).toEqual([]);
  });

  it("still classifies the real ratings page that the TOC merely points at", () => {
    // the discriminating pair: same phrase, but this page has the actual table
    const result = triageFromText([
      {
        page: 13,
        text: "Absolute maximum ratings The absolute maximum ratings are determined over complete temperature range. Parameter Condition Min Max Unit Voltage at any supply pin VDD and VDDIO pin -0.3 4.25 V",
      },
    ]);
    expect(result.sectionMap["13"]).toBe("absolute-max");
  });

  it("does not classify from a cross-reference deep in the page body", () => {
    const filler = "This chapter describes the register interface in detail. ".repeat(20);
    const result = triageFromText([
      { page: 27, text: `${filler} see Absolute Maximum Ratings on page 13 for limits.` },
    ]);
    expect(result.sectionMap["27"]).toBeUndefined();
    expect(result.unclassified).toEqual([27]);
  });
});
