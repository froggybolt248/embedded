import { describe, expect, it } from "vitest";
import { SourcedRange, SourcedValue, ValueSource, manualValue } from "./sourced-value.js";

describe("ValueSource", () => {
  it("accepts each provenance kind when its citation requirements are met", () => {
    expect(
      ValueSource.safeParse({ kind: "datasheet", datasheetId: "ds1", page: 1, snippet: "x" })
        .success,
    ).toBe(true);
    expect(ValueSource.safeParse({ kind: "calculator", calculatorRunId: "run1" }).success).toBe(
      true,
    );
    expect(ValueSource.safeParse({ kind: "manual" }).success).toBe(true);
    expect(ValueSource.safeParse({ kind: "llm" }).success).toBe(true);
  });

  it("rejects a kind outside the enum", () => {
    const result = ValueSource.safeParse({ kind: "guess" });
    expect(result.success).toBe(false);
  });

  it("requires datasheetId/page/snippet when kind is 'datasheet'", () => {
    // The app's central promise is that every datasheet-grounded number can be
    // traced to a page and a snippet. An uncited datasheet source cannot be
    // rendered in the provenance popover or checked by a human, so the schema
    // must refuse it outright rather than trust convention.
    const bare = ValueSource.safeParse({ kind: "datasheet" });
    expect(bare.success).toBe(false);
    if (!bare.success) {
      const paths = bare.error.issues.map((i) => i.path.join("."));
      expect(paths).toContain("datasheetId");
      expect(paths).toContain("page");
      expect(paths).toContain("snippet");
    }

    // partial citations are just as unusable — each missing field is reported
    expect(
      ValueSource.safeParse({ kind: "datasheet", datasheetId: "ds1", page: 12 }).success,
    ).toBe(false);
  });

  it("requires calculatorRunId when kind is 'calculator'", () => {
    expect(ValueSource.safeParse({ kind: "calculator" }).success).toBe(false);
    expect(ValueSource.safeParse({ kind: "calculator", calculatorRunId: "run1" }).success).toBe(
      true,
    );
  });

  it("accepts a fully-populated datasheet citation", () => {
    const result = ValueSource.safeParse({
      kind: "datasheet",
      datasheetId: "ds1",
      page: 12,
      snippet: "VDD = 3.3V typ",
      confidence: 0.92,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a bare manual or llm source — neither cites a datasheet", () => {
    expect(ValueSource.safeParse({ kind: "manual" }).success).toBe(true);
    expect(ValueSource.safeParse({ kind: "llm" }).success).toBe(true);
  });

  it("round-trips both rungs of the trust ladder", () => {
    for (const rung of ["human", "machine"] as const) {
      const result = ValueSource.safeParse({ kind: "manual", verifiedBy: rung });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.verifiedBy).toBe(rung);
      }
    }
  });

  it("rejects verifiedBy values outside the trust ladder", () => {
    const result = ValueSource.safeParse({ kind: "manual", verifiedBy: "ai" });
    expect(result.success).toBe(false);
  });

  it("rejects page numbers that are not positive integers", () => {
    const cite = { kind: "datasheet", datasheetId: "ds1", snippet: "x" };
    expect(ValueSource.safeParse({ ...cite, page: 0 }).success).toBe(false);
    expect(ValueSource.safeParse({ ...cite, page: -1 }).success).toBe(false);
    expect(ValueSource.safeParse({ ...cite, page: 1.5 }).success).toBe(false);
    expect(ValueSource.safeParse({ ...cite, page: 1 }).success).toBe(true);
  });

  it("rejects confidence outside [0, 1]", () => {
    expect(ValueSource.safeParse({ kind: "llm", confidence: 1.5 }).success).toBe(false);
    expect(ValueSource.safeParse({ kind: "llm", confidence: -0.1 }).success).toBe(false);
    expect(ValueSource.safeParse({ kind: "llm", confidence: 0 }).success).toBe(true);
    expect(ValueSource.safeParse({ kind: "llm", confidence: 1 }).success).toBe(true);
  });
});

describe("SourcedValue", () => {
  it("parses a minimal valid value", () => {
    const result = SourcedValue.safeParse({
      value: 3.3,
      unit: "V",
      source: { kind: "manual" },
    });
    expect(result.success).toBe(true);
  });

  it("requires value, unit, and source", () => {
    expect(SourcedValue.safeParse({ unit: "V", source: { kind: "manual" } }).success).toBe(false);
    expect(SourcedValue.safeParse({ value: 3.3, source: { kind: "manual" } }).success).toBe(false);
    expect(SourcedValue.safeParse({ value: 3.3, unit: "V" }).success).toBe(false);
  });

  it("accepts the min/typ/max bound qualifier and rejects other strings", () => {
    for (const bound of ["min", "typ", "max"] as const) {
      const result = SourcedValue.safeParse({
        value: 1,
        unit: "A",
        bound,
        source: { kind: "manual" },
      });
      expect(result.success).toBe(true);
    }
    const bad = SourcedValue.safeParse({
      value: 1,
      unit: "A",
      bound: "average",
      source: { kind: "manual" },
    });
    expect(bad.success).toBe(false);
  });

  it("leaves bound/conditions absent when not supplied", () => {
    const result = SourcedValue.safeParse({ value: 1, unit: "A", source: { kind: "manual" } });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.bound).toBeUndefined();
      expect(result.data.conditions).toBeUndefined();
    }
  });
});

describe("SourcedRange", () => {
  it("allows all three bounds to be absent (fully unknown range)", () => {
    const result = SourcedRange.safeParse({});
    expect(result.success).toBe(true);
  });

  it("parses a full min/typ/max triple", () => {
    const source: ValueSource = {
      kind: "datasheet",
      datasheetId: "ds1",
      page: 5,
      snippet: "VDD 1.7 3.3 3.6 V",
    };
    const result = SourcedRange.safeParse({
      min: { value: 1.7, unit: "V", source },
      typ: { value: 3.3, unit: "V", source },
      max: { value: 3.6, unit: "V", source },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed nested value", () => {
    const result = SourcedRange.safeParse({
      typ: { value: "not-a-number", unit: "V", source: { kind: "manual" } },
    });
    expect(result.success).toBe(false);
  });
});

describe("manualValue", () => {
  it("builds a value with source kind 'manual' and verifiedBy 'human'", () => {
    const v = manualValue(3.3, "V");
    expect(v).toEqual({ value: 3.3, unit: "V", source: { kind: "manual", verifiedBy: "human" } });
  });

  it("includes conditions only when provided (never an explicit undefined key)", () => {
    const withConditions = manualValue(10, "mA", "VDD=3.3V");
    expect(withConditions.conditions).toBe("VDD=3.3V");
    expect("conditions" in withConditions).toBe(true);

    const without = manualValue(10, "mA");
    expect("conditions" in without).toBe(false);
  });

  it("produces output that satisfies the SourcedValue schema", () => {
    const result = SourcedValue.safeParse(manualValue(1.8, "V", "TA=25C"));
    expect(result.success).toBe(true);
  });
});
