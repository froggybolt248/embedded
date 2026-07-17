import { describe, expect, it } from "vitest";
import { checkGrounding, snippetContainsValues, snippetOnPage } from "./verify.js";
import { verifySection } from "./pipeline.js";

/**
 * Fixtures are verbatim rows from a real qwen2.5vl:7b run on the BME280
 * datasheet (run hSUmppXGMafYql98gyiPN, prompt v6) — the good citation and the
 * fabricated one, exactly as the model emitted them.
 */
const GOOD = {
  param: "vdd",
  label: "Voltage at any supply pin",
  min: -0.3,
  typ: null,
  max: 4.25,
  unit: "V",
  page: 13,
  snippet: "Voltage at any supply pin VDD and VDDIO pin -0.3 4.25",
};

const FABRICATED = {
  param: "tOperating",
  label: "Operating temperature",
  min: -40,
  typ: 25,
  max: 85,
  unit: "°C",
  page: 23,
  snippet:
    "Note that in I²C mode, even when pressure was not measured, reading the unused registers is faster than reading temperature and humidity data separately.",
};

describe("snippetContainsValues", () => {
  it("accepts a snippet that prints every cited number", () => {
    expect(snippetContainsValues(GOOD.snippet, [GOOD.min, GOOD.typ, GOOD.max])).toBe(true);
  });

  it("rejects the real fabricated citation, whose prose supports none of its numbers", () => {
    expect(
      snippetContainsValues(FABRICATED.snippet, [FABRICATED.min, FABRICATED.typ, FABRICATED.max]),
    ).toBe(false);
  });

  it("ignores nulls — an absent column is not an unsupported claim", () => {
    expect(snippetContainsValues("Storage temperature -45 85", [-45, null, 85])).toBe(true);
  });

  it("is vacuously true when a row cites no numbers at all", () => {
    expect(snippetContainsValues("100 nF close to VDD", [])).toBe(true);
  });

  it("matches numerically, not textually, across datasheet number formatting", () => {
    // unicode minus, thousands separator, and a decimal the model may re-render
    expect(snippetContainsValues("Pressure 0 to 20,000 hPa", [0, 20000])).toBe(true);
    expect(snippetContainsValues("Voltage −0.3 max", [-0.3])).toBe(true);
  });

  it("does not accept a near-miss value", () => {
    expect(snippetContainsValues("supply 3.3 V", [3.4])).toBe(false);
  });

  it("does not let a substring of a longer number count as a match", () => {
    expect(snippetContainsValues("clock 3400000 Hz", [340])).toBe(false);
  });
});

describe("snippetOnPage", () => {
  it("accepts a verbatim quote despite whitespace and unicode differences", () => {
    const pageText = "Voltage at any\n supply  pin VDD and VDDIO pin −0.3 4.25 V";
    expect(snippetOnPage(GOOD.snippet, pageText)).toBe(true);
  });

  it("rejects a snippet invented wholesale", () => {
    expect(snippetOnPage("The BME280 runs on unicorn tears", "Voltage at any supply pin")).toBe(false);
  });
});

describe("checkGrounding", () => {
  it("verifies a well-cited row", () => {
    const page = "Voltage at any supply pin VDD and VDDIO pin -0.3 4.25 V";
    expect(checkGrounding(GOOD, [GOOD.min, GOOD.typ, GOOD.max], page)).toBe("verified");
  });

  it("flags the fabricated row even though its snippet IS real text from that page", () => {
    // the discriminating case: check 2 alone would pass this
    const page = `Some preamble. ${FABRICATED.snippet} More prose.`;
    expect(snippetOnPage(FABRICATED.snippet, page)).toBe(true);
    expect(
      checkGrounding(FABRICATED, [FABRICATED.min, FABRICATED.typ, FABRICATED.max], page),
    ).toBe("value-not-in-snippet");
  });

  it("flags a snippet that does not appear on the cited page", () => {
    expect(checkGrounding(GOOD, [GOOD.min, GOOD.typ, GOOD.max], "an unrelated page")).toBe(
      "snippet-not-on-page",
    );
  });

  it("skips the page check for an image-only page rather than failing it", () => {
    expect(checkGrounding(GOOD, [GOOD.min, GOOD.typ, GOOD.max], "")).toBe("verified");
    expect(checkGrounding(GOOD, [GOOD.min, GOOD.typ, GOOD.max], undefined)).toBe("verified");
  });
});

describe("verifySection", () => {
  const pageText = new Map([
    [13, "Voltage at any supply pin VDD and VDDIO pin -0.3 4.25 V. Sleep current IDDSL 0.1 0.3 µA"],
    [23, FABRICATED.snippet],
  ]);

  it("drops rated rows that state no value at all", () => {
    const valueless = { ...GOOD, page: 13, min: null, typ: null, max: null };
    const out = verifySection({ recommendedOperating: [valueless, GOOD] }, pageText);
    expect(out.recommendedOperating).toHaveLength(1);
    expect(out.recommendedOperating?.[0]?.max).toBe(4.25);
  });

  it("drops power states with neither a typ nor a max current", () => {
    const row = { name: "sleep", unit: "µA", page: 13, snippet: "Sleep current IDDSL 0.1 0.3 µA" };
    const out = verifySection(
      {
        powerStates: [
          { ...row, currentTyp: null, currentMax: null },
          { ...row, currentTyp: 0.1, currentMax: 0.3 },
        ],
      },
      pageText,
    );
    expect(out.powerStates).toHaveLength(1);
    expect(out.powerStates?.[0]?.grounding).toBe("verified");
  });

  it("keeps an unquantified decoupling note", () => {
    const out = verifySection(
      {
        decoupling: [
          { description: "100 nF close to VDD", value: null, page: 13, snippet: "Voltage at any supply pin" },
        ],
      },
      pageText,
    );
    expect(out.decoupling).toHaveLength(1);
  });

  it("keeps a badly-cited row but marks it, rather than hiding it", () => {
    const out = verifySection({ recommendedOperating: [FABRICATED] }, pageText);
    expect(out.recommendedOperating).toHaveLength(1);
    expect(out.recommendedOperating?.[0]?.grounding).toBe("value-not-in-snippet");
  });
});
