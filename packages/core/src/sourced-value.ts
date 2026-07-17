import { z } from "zod";

/**
 * Provenance for a single datum. Every numeric/spec value in the app carries
 * one of these; the UI renders it as a provenance popover and the grounding
 * validator uses it to verify LLM claims.
 */
const ValueSourceFields = z.object({
  kind: z.enum(["datasheet", "manual", "calculator", "llm"]),
  /** required when kind === 'datasheet' */
  datasheetId: z.string().optional(),
  /** 1-indexed datasheet page the value was read from */
  page: z.number().int().positive().optional(),
  /** verbatim snippet of the source row/sentence */
  snippet: z.string().optional(),
  /** required when kind === 'calculator' */
  calculatorRunId: z.string().optional(),
  /** extractor confidence 0..1; absent for manual entry */
  confidence: z.number().min(0).max(1).optional(),
  /**
   * The trust ladder (user decision, 2026-07-15). `human`: accepted in the
   * review UI. `machine`: copied verbatim from the PDF text layer by the
   * deterministic extractor and passed the grounding check — auto-accepted,
   * always auditable via its citation. A value an LLM transcribed can never
   * be `machine`; it stays unverified until a human reviews it.
   */
  verifiedBy: z.enum(["human", "machine"]).optional(),
});

/**
 * Provenance for a single datum. Every numeric/spec value in the app carries
 * one of these; the UI renders it as a provenance popover and the grounding
 * validator uses it to verify LLM claims.
 *
 * The citation fields are ENFORCED, not merely documented: "every value cites a
 * datasheet page and snippet" is this app's central promise, and an optional
 * field that convention says is required is a promise waiting to be broken. A
 * `datasheet` source with no page cannot be rendered in the provenance popover
 * or checked by a human, so it must not exist in the first place.
 */
export const ValueSource = ValueSourceFields.superRefine((s, ctx) => {
  if (s.kind === "datasheet") {
    for (const field of ["datasheetId", "page", "snippet"] as const) {
      if (s[field] === undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [field],
          message: `a datasheet-sourced value must cite its ${field}`,
        });
      }
    }
  }
  if (s.kind === "calculator" && s.calculatorRunId === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["calculatorRunId"],
      message: "a calculator-sourced value must cite its calculatorRunId",
    });
  }
});
export type ValueSource = z.infer<typeof ValueSource>;

/** Conditions under which a spec value holds, e.g. "VDD=3.3V, TA=25°C". */
export const SpecConditions = z.string();

export const SourcedValue = z.object({
  value: z.number(),
  unit: z.string(),
  /** min/typ/max qualifier when the datasheet row has one */
  bound: z.enum(["min", "typ", "max"]).optional(),
  conditions: SpecConditions.optional(),
  source: ValueSource,
});
export type SourcedValue = z.infer<typeof SourcedValue>;

/** A min/typ/max triple as it appears in electrical-characteristics tables. */
export const SourcedRange = z.object({
  min: SourcedValue.optional(),
  typ: SourcedValue.optional(),
  max: SourcedValue.optional(),
});
export type SourcedRange = z.infer<typeof SourcedRange>;

export function manualValue(value: number, unit: string, conditions?: string): SourcedValue {
  return {
    value,
    unit,
    ...(conditions !== undefined ? { conditions } : {}),
    source: { kind: "manual", verifiedBy: "human" },
  };
}
