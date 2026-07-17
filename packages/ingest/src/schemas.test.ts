import { describe, expect, it } from "vitest";
import { toJsonSchema } from "@embedded/llm";
import { ExtractedDecoupling, ExtractedPowerState, ExtractedRatedParam } from "./schemas.js";

/**
 * Guards the fix for a silent data-loss bug. These value keys were
 * `.nullable().optional()`, which keeps them out of the JSON schema's
 * `required` list — so a schema-constrained model was free to omit them, and
 * qwen2.5vl omitted every one: rows arrived with a correct label, unit, page
 * and a snippet still containing the numbers, but no numbers. The run reported
 * success. Nothing but a hand-audit of the rows revealed it.
 *
 * Required-and-nullable is the contract: emit a number, or an explicit null.
 */
function requiredKeys(schema: Parameters<typeof toJsonSchema>[0]): string[] {
  return (toJsonSchema(schema) as { required?: string[] }).required ?? [];
}

function propertyType(schema: Parameters<typeof toJsonSchema>[0], key: string): unknown {
  const props = (toJsonSchema(schema) as { properties: Record<string, { type?: unknown }> })
    .properties;
  return props[key]?.type;
}

describe("extraction schemas force the model to transcribe values", () => {
  it.each([
    ["ExtractedRatedParam", ExtractedRatedParam, ["min", "typ", "max"]],
    ["ExtractedPowerState", ExtractedPowerState, ["currentTyp", "currentMax"]],
    ["ExtractedDecoupling", ExtractedDecoupling, ["value"]],
  ] as const)("%s marks its value keys required", (_name, schema, keys) => {
    const required = requiredKeys(schema);
    for (const key of keys) expect(required).toContain(key);
  });

  it.each([
    ["ExtractedRatedParam", ExtractedRatedParam, ["min", "typ", "max"]],
    ["ExtractedPowerState", ExtractedPowerState, ["currentTyp", "currentMax"]],
    ["ExtractedDecoupling", ExtractedDecoupling, ["value"]],
  ] as const)("%s still lets its value keys be null", (_name, schema, keys) => {
    for (const key of keys) expect(propertyType(schema, key)).toEqual(["number", "null"]);
  });

  it("accepts an explicit null for a column the table does not have", () => {
    const parsed = ExtractedRatedParam.parse({
      param: "vdd",
      label: "Voltage at any supply pin",
      min: -0.3,
      typ: null,
      max: 4.25,
      unit: "V",
      page: 13,
      snippet: "Voltage at any supply pin VDD and VDDIO pin -0.3 4.25",
    });
    expect(parsed.typ).toBeNull();
    expect(parsed.max).toBe(4.25);
  });

  it("rejects a row that omits its values entirely", () => {
    // exactly the shape qwen2.5vl was returning
    const result = ExtractedRatedParam.safeParse({
      param: "vdd",
      label: "Voltage at any supply pin",
      unit: "V",
      page: 13,
      snippet: "Voltage at any supply pin VDD and VDDIO pin -0.3 4.25",
    });
    expect(result.success).toBe(false);
  });
});
