import { z } from "zod";

/**
 * Structured claim shape assistants must use for numeric statements.
 * The grounding contract: an LLM never freehands a spec number — it either
 * cites a datasheet page, an ingested spec path, or a calculator run.
 */
export const Citation = z.union([
  z.object({ kind: z.literal("datasheet"), datasheetId: z.string(), page: z.number().int() }),
  z.object({ kind: z.literal("spec"), componentId: z.string(), specPath: z.string() }),
  z.object({ kind: z.literal("calculator"), calculatorRunId: z.string() }),
]);
export type Citation = z.infer<typeof Citation>;

export const GroundedClaim = z.object({
  claim: z.string(),
  value: z.number().optional(),
  unit: z.string().optional(),
  citation: Citation.optional(),
});
export type GroundedClaim = z.infer<typeof GroundedClaim>;

/** number followed by an engineering unit, e.g. "3.3 V", "966Ω", "400 kHz" */
const NUMBER_WITH_UNIT =
  /\b\d+(?:\.\d+)?\s?(?:[munpkMG]?(?:A|V|W|Hz|F|H|Ω|ohm|Ohm)|µ[AVWF]|u[AVWF]|mAh|Wh|dBm?|°C|ppm|%|bps|kbps|Mbps|ms|µs|us|ns|s)(?![A-Za-z0-9])/g;

export interface UngroundedFinding {
  match: string;
  index: number;
}

/**
 * Scan free text for bare number-with-unit tokens. The UI flags each one as
 * "ungrounded" unless the surrounding claim object carries a citation —
 * findings are surfaced, never hidden.
 */
export function findNumericClaims(text: string): UngroundedFinding[] {
  const findings: UngroundedFinding[] = [];
  for (const m of text.matchAll(NUMBER_WITH_UNIT)) {
    findings.push({ match: m[0].trim(), index: m.index ?? 0 });
  }
  return findings;
}

/** Claims that state a value/unit but cite nothing — the validator's core check. */
export function ungroundedClaims(claims: GroundedClaim[]): GroundedClaim[] {
  return claims.filter((c) => (c.value !== undefined || c.unit !== undefined) && !c.citation);
}
