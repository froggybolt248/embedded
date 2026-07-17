import type { ValueSource } from "@embedded/core";

/**
 * Decoupling / bypass capacitor defaults.
 *
 * Unlike i2c-pullup.ts or bulk-cap.ts, there is no equation here to derive
 * "the right" answer from first principles — decoupling values come from one
 * of two places, and the difference between them matters:
 *
 *   1. The part's own datasheet states a recommendation (e.g. "100 nF X7R
 *      within 5 mm of each VDD pin, 1 uF bulk per rail"). That is a grounded
 *      fact and outranks everything below it.
 *   2. Nobody stated one, so the industry falls back on a rule of thumb: 100
 *      nF ceramic per supply pin, placed close, plus 1-10 uF bulk per rail.
 *      This is a CONVENTION, not a measurement of this specific part — it is
 *      "usually fine," not "verified by the manufacturer." Presenting it with
 *      a citation, as if a datasheet said it, is exactly the confidently-cited
 *      wrong number this app exists to prevent. So the convention path never
 *      produces a `ValueSource`; it produces a plain-text `note` instead, and
 *      the type system makes the two paths impossible to confuse (see
 *      `DecouplingBasis` below).
 */

/** Where a recommendation came from — the caller must handle both cases. */
export type DecouplingBasis =
  | {
      kind: "datasheet";
      /** citation for the datasheet's own stated recommendation */
      source: ValueSource;
    }
  | {
      kind: "convention";
      /** why this number, in place of a fake citation */
      note: string;
    };

/** A part's own datasheet-stated decoupling recommendation, when it has one. */
export interface DatasheetDecouplingRecommendation {
  /** ceramic capacitance recommended per supply pin, farads */
  perPinCapacitanceF: number;
  /** bulk capacitance recommended per rail, farads */
  bulkCapacitanceF: number;
  source: ValueSource;
}

export interface DecouplingInput {
  /** number of VDD/supply pins on this rail that need bypassing */
  supplyPinCount: number;
  /**
   * The part's own stated recommendation, if the datasheet gives one. When
   * present it is used verbatim in place of the generic convention below —
   * the caller is expected to have pulled this from the part's specs, not
   * to invent it.
   */
  datasheetRecommendation?: DatasheetDecouplingRecommendation | undefined;
}

export interface DecouplingResult {
  /** ceramic capacitance recommended per supply pin, farads */
  perPinCapacitanceF: number;
  /** ceramic capacitance summed across every supply pin, farads */
  totalCeramicCapacitanceF: number;
  /** bulk capacitance recommended for the rail, farads */
  bulkCapacitanceF: number;
  /** the low/high ends of the generic bulk range this recommendation sits in;
   *  null when the recommendation came from the datasheet, which states a
   *  single value rather than a range */
  bulkRangeF: { minF: number; maxF: number } | null;
  basis: DecouplingBasis;
}

/** 100 nF per VDD pin, placed within a few mm — EDN/industry rule of thumb,
 *  not a spec: it targets the ceramic's self-resonant frequency landing well
 *  above typical digital edge rates, not any single part's actual transient
 *  demand. */
const CONVENTION_PER_PIN_F = 100e-9;
const CONVENTION_BULK_MIN_F = 1e-6;
const CONVENTION_BULK_MAX_F = 10e-6;

export function decoupling(input: DecouplingInput): DecouplingResult {
  const dr = input.datasheetRecommendation;

  if (dr !== undefined) {
    return {
      perPinCapacitanceF: dr.perPinCapacitanceF,
      totalCeramicCapacitanceF: dr.perPinCapacitanceF * input.supplyPinCount,
      bulkCapacitanceF: dr.bulkCapacitanceF,
      bulkRangeF: null,
      basis: { kind: "datasheet", source: dr.source },
    };
  }

  // No stated recommendation: fall back to the convention. The bulk value
  // reported is the geometric mean of the 1-10 uF window (~3.16 uF) — a
  // starting point picked the same way i2c-pullup.ts picks a resistor inside
  // its legal window, biased to neither edge of the range, NOT a computed
  // answer to how much transient current this specific rail actually needs.
  // A rail with a known pulsed load (a radio TX burst, a motor stall) should
  // be sized with bulk-cap.ts's pulsedLoad() instead, which reasons from the
  // actual current and duration rather than a convention.
  const bulkCapacitanceF = Math.sqrt(CONVENTION_BULK_MIN_F * CONVENTION_BULK_MAX_F);

  return {
    perPinCapacitanceF: CONVENTION_PER_PIN_F,
    totalCeramicCapacitanceF: CONVENTION_PER_PIN_F * input.supplyPinCount,
    bulkCapacitanceF,
    bulkRangeF: { minF: CONVENTION_BULK_MIN_F, maxF: CONVENTION_BULK_MAX_F },
    basis: {
      kind: "convention",
      note:
        "no datasheet-stated recommendation was supplied; this is the generic " +
        "100 nF/pin + 1-10 uF/rail industry convention, not a spec for this part",
    },
  };
}
