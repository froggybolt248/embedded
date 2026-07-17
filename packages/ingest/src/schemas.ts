import { z } from "zod";
import { DatasheetSection, PinFunction, PowerMode } from "@embedded/core";

/**
 * What the LLM returns during extraction. Every value-bearing entry MUST
 * carry the page it came from and a verbatim-ish snippet — that provenance
 * becomes the SourcedValue citation when the review is committed. No page,
 * no snippet → the field fails validation and the extraction retries.
 */

export const TriageResult = z.object({
  pages: z.array(
    z.object({
      page: z.number().int().positive(),
      section: DatasheetSection,
    }),
  ),
});
export type TriageResult = z.infer<typeof TriageResult>;

/**
 * Set by the pipeline's deterministic check (see verify.ts), never by the
 * model — anything the model puts here is overwritten. It rides on the same
 * schema because it is stored and reviewed alongside the row it judges.
 */
export const GroundingStatus = z.enum(["verified", "value-not-in-snippet", "snippet-not-on-page"]);
export type GroundingStatus = z.infer<typeof GroundingStatus>;

/**
 * Which tier produced a row. Set by the pipeline, never by the model — anything
 * the model writes here is overwritten.
 *
 * `deterministic` means the value was parsed straight out of the PDF text layer
 * at known coordinates, with no transcription step in which a model could
 * drift. That is what lets such a row be auto-accepted as `verifiedBy:
 * 'machine'` at commit time, while an `llm` row stays unverified until a human
 * looks at it. Absent = llm (the conservative reading for rows written before
 * the deterministic tier existed).
 */
export const Extractor = z.enum(["deterministic", "llm"]);
export type Extractor = z.infer<typeof Extractor>;

const Provenance = {
  page: z.number().int().positive(),
  snippet: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1).optional(),
  grounding: GroundingStatus.optional(),
  extractor: Extractor.optional(),
};

/**
 * `min`/`typ`/`max` are nullable but NOT optional, and that distinction is the
 * whole point: an optional key is absent from the JSON schema's `required`
 * list, so a schema-constrained model may legally skip it — and qwen2.5vl did,
 * on every row. It returned param/label/unit/page and a snippet that still had
 * the numbers in it ("Voltage at any supply pin VDD and VDDIO pin -0.3 4.25"),
 * having simply declined to transcribe them. A rated parameter with no value is
 * not a partial answer, it is a non-answer. Required-and-nullable forces the
 * model to commit: a number, or an explicit null meaning "this table has no
 * such column". The prompt has asked for these since v1; only the schema made
 * it true.
 */
export const ExtractedRatedParam = z.object({
  /** canonical id, e.g. "vdd", "vio", "tOperating" */
  param: z.string().min(1),
  label: z.string().min(1),
  min: z.number().nullable(),
  typ: z.number().nullable(),
  max: z.number().nullable(),
  unit: z.string().min(1),
  conditions: z.string().optional(),
  ...Provenance,
});
export type ExtractedRatedParam = z.infer<typeof ExtractedRatedParam>;

export const ExtractedPowerState = z.object({
  /**
   * What makes this row unique — near-verbatim from the datasheet, e.g.
   * "Supply current, pressure measurement". NOT the coarse mode: several rows
   * in one table are all "active" and would collapse onto each other.
   */
  name: z.string().min(1),
  /** coarse bucket for calculators; omitted when the row names no known mode */
  mode: PowerMode.optional(),
  /** required-and-nullable for the reason given on ExtractedRatedParam */
  currentTyp: z.number().nullable(),
  currentMax: z.number().nullable(),
  unit: z.string().min(1),
  conditions: z.string().optional(),
  ...Provenance,
});
export type ExtractedPowerState = z.infer<typeof ExtractedPowerState>;

/**
 * Closed vocabulary at the LLM boundary, enforced by the schema rather than
 * merely requested by the prompt: the same pin table gets re-read from several
 * pages, and free text made one call say "supply" and the next "Power supply" —
 * the same pin, undedupable, and useless to firmware codegen. The enum reaches
 * the provider as a JSON-schema `enum`, so prose is rejected and the extract
 * retry corrects it.
 */
export const ExtractedPin = z.object({
  name: z.string().min(1),
  number: z.string().optional(),
  functions: z.array(PinFunction).default([]),
  voltage: z.string().optional(),
  page: Provenance.page,
});
export type ExtractedPin = z.infer<typeof ExtractedPin>;

export const ExtractedInterface = z.object({
  kind: z.enum(["i2c", "spi", "uart", "gpio", "analog", "pwm", "usb", "rf", "power"]),
  /** e.g. { "address": "0x76/0x77", "maxClockHz": 3400000 } */
  attrs: z.record(z.union([z.string(), z.number()])).default({}),
  ...Provenance,
});
export type ExtractedInterface = z.infer<typeof ExtractedInterface>;

export const ExtractedIdentity = z.object({
  mpn: z.string().min(1),
  manufacturer: z.string().optional(),
  description: z.string().optional(),
  ...Provenance,
});

/**
 * One orderable part enumerated by an ordering-information table.
 *
 * Most datasheets describe a family, not a part: STM32F103x8/xB lists dozens
 * of MPNs differing only in flash, package and temperature grade. The ordering
 * table is the document's own machine-readable enumeration of that family, so
 * it is a first-class extraction target rather than an afterthought — it is
 * the difference between ingesting one datasheet as one component and
 * ingesting it as the thirty parts it actually documents.
 */
export const ExtractedVariant = z.object({
  /** the orderable code exactly as printed, e.g. "STM32F103C8T6" */
  orderingCode: z.string().min(1),
  /** distinguishing attributes as printed, e.g. { flash: "64 KB", package: "LQFP48" } */
  attrs: z.record(z.string()).default({}),
  ...Provenance,
});
export type ExtractedVariant = z.infer<typeof ExtractedVariant>;

export const ExtractedDecoupling = z.object({
  description: z.string().min(1),
  /** required-and-nullable for the reason given on ExtractedRatedParam */
  value: z.number().nullable(),
  unit: z.string().optional(),
  ...Provenance,
});

/** Full extraction output — mirrors ComponentSpecs, provenance-per-field. */
export const ExtractionFields = z.object({
  identity: ExtractedIdentity.nullable().default(null),
  /** orderable parts this datasheet enumerates; empty for a single-part doc */
  variants: z.array(ExtractedVariant).default([]),
  absoluteMax: z.array(ExtractedRatedParam).default([]),
  recommendedOperating: z.array(ExtractedRatedParam).default([]),
  powerStates: z.array(ExtractedPowerState).default([]),
  pins: z.array(ExtractedPin).default([]),
  interfaces: z.array(ExtractedInterface).default([]),
  decoupling: z.array(ExtractedDecoupling).default([]),
});
export type ExtractionFields = z.infer<typeof ExtractionFields>;

/** Per-section partial results, merged by the pipeline. */
export const SectionExtraction = ExtractionFields.partial();
export type SectionExtraction = z.infer<typeof SectionExtraction>;
