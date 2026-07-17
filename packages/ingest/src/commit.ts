import {
  ComponentSpecs,
  type SourcedRange,
  type SourcedValue,
  type ValueSource,
} from "@embedded/core";
import type {
  ExtractedPowerState,
  ExtractedRatedParam,
  Extractor,
  ExtractionFields,
} from "./schemas.js";

/**
 * Convert extraction fields into ComponentSpecs.
 *
 * Trust is decided per row, not per commit. A human accepting rows in the
 * review UI stamps `human` on all of them. Otherwise — the bulk-ingest path,
 * where nobody looked — a row parsed deterministically out of the PDF text
 * layer earns `machine`, because its value came from the very cell its
 * citation points at; a row an LLM transcribed earns nothing and stays
 * unverified until someone reviews it. Mass ingest is only safe because those
 * two cases are distinguishable.
 */
export function fieldsToSpecs(
  fields: ExtractionFields,
  datasheetId: string,
  opts: { verified: boolean } = { verified: true },
): ComponentSpecs {
  const trust = (extractor: Extractor | undefined): "human" | "machine" | undefined => {
    if (opts.verified) return "human";
    return extractor === "deterministic" ? "machine" : undefined;
  };

  const src = (
    page: number,
    snippet: string,
    confidence?: number,
    extractor?: Extractor,
  ): ValueSource => {
    const verifiedBy = trust(extractor);
    return {
      kind: "datasheet",
      datasheetId,
      page,
      snippet,
      ...(confidence !== undefined ? { confidence } : {}),
      ...(verifiedBy !== undefined ? { verifiedBy } : {}),
    };
  };

  const sv = (
    value: number,
    unit: string,
    bound: "min" | "typ" | "max",
    row: {
      page: number;
      snippet: string;
      confidence?: number | undefined;
      conditions?: string | undefined;
      extractor?: Extractor | undefined;
    },
  ): SourcedValue => ({
    value,
    unit,
    bound,
    ...(row.conditions !== undefined ? { conditions: row.conditions } : {}),
    source: src(row.page, row.snippet, row.confidence, row.extractor),
  });

  const toRange = (row: ExtractedRatedParam): SourcedRange => ({
    ...(row.min !== undefined && row.min !== null ? { min: sv(row.min, row.unit, "min", row) } : {}),
    ...(row.typ !== undefined && row.typ !== null ? { typ: sv(row.typ, row.unit, "typ", row) } : {}),
    ...(row.max !== undefined && row.max !== null ? { max: sv(row.max, row.unit, "max", row) } : {}),
  });

  const toPowerRange = (row: ExtractedPowerState): SourcedRange => ({
    ...(row.currentTyp !== undefined && row.currentTyp !== null
      ? { typ: sv(row.currentTyp, row.unit, "typ", row) }
      : {}),
    ...(row.currentMax !== undefined && row.currentMax !== null
      ? { max: sv(row.currentMax, row.unit, "max", row) }
      : {}),
  });

  return ComponentSpecs.parse({
    absoluteMax: fields.absoluteMax.map((row) => ({
      param: row.param,
      label: row.label,
      range: toRange(row),
    })),
    recommendedOperating: fields.recommendedOperating.map((row) => ({
      param: row.param,
      label: row.label,
      range: toRange(row),
    })),
    powerStates: fields.powerStates.map((row) => ({
      name: row.name,
      ...(row.mode !== undefined ? { mode: row.mode } : {}),
      current: toPowerRange(row),
      ...(row.conditions !== undefined ? { conditions: row.conditions } : {}),
    })),
    pins: fields.pins.map((pin) => ({
      name: pin.name,
      ...(pin.number !== undefined ? { number: pin.number } : {}),
      functions: pin.functions,
      ...(pin.voltage !== undefined ? { voltage: pin.voltage } : {}),
    })),
    interfaces: fields.interfaces.map((iface) => ({
      kind: iface.kind,
      attrs: iface.attrs,
    })),
    decoupling: fields.decoupling.map((d) => ({
      description: d.description,
      ...(d.value !== undefined && d.value !== null && d.unit
        ? {
            value: {
              value: d.value,
              unit: d.unit,
              source: src(d.page, d.snippet, d.confidence, d.extractor),
            },
          }
        : {}),
    })),
  });
}
