import { z } from "zod";
import { SourcedRange, SourcedValue, type ValueSource } from "./sourced-value.js";

export const Lifecycle = z.enum(["active", "nrnd", "eol", "obsolete", "unknown"]);
export type Lifecycle = z.infer<typeof Lifecycle>;

export const ComponentCategory = z.enum([
  "mcu",
  "sensor",
  "radio",
  "power",
  "actuator-driver",
  "display",
  "memory",
  "connector",
  "passive",
  "discrete",
  "other",
]);
export type ComponentCategory = z.infer<typeof ComponentCategory>;

export const InterfaceKind = z.enum([
  "i2c",
  "spi",
  "uart",
  "gpio",
  "analog",
  "pwm",
  "usb",
  "rf",
  "power",
]);
export type InterfaceKind = z.infer<typeof InterfaceKind>;

/** One row of an absolute-maximum or recommended-operating table. */
export const RatedParam = z.object({
  /** canonical parameter id, e.g. "vdd", "vio", "tOperating", "iOutMax" */
  param: z.string(),
  label: z.string(),
  range: SourcedRange,
});
export type RatedParam = z.infer<typeof RatedParam>;

/**
 * Canonical operating modes. Calculators and archetype recipes select by mode
 * ("what is the part doing"), which is a much smaller vocabulary than the
 * names datasheets actually print.
 */
export const PowerMode = z.enum(["sleep", "standby", "active", "tx", "rx", "refresh"]);
export type PowerMode = z.infer<typeof PowerMode>;

/**
 * A duty expressed the way designers state it — "every 60 s, for 80 ms".
 * Lives here (rather than in `knowledge.ts`, which re-exports it for back
 * compat) because both `design.ts` (blocks) and `knowledge.ts` (archetype
 * recipes) need it, and `component.ts` is the shared base both already
 * depend on — putting it in either of those two would create a cycle.
 */
export const DutyCycle = z.object({
  everySec: z.number().positive(),
  forMs: z.number().nonnegative(),
});
export type DutyCycle = z.infer<typeof DutyCycle>;

/**
 * Current consumption in one operating state — the atom of every power budget.
 *
 * `name` and `mode` are deliberately separate. A datasheet does not list one
 * "active" current; the BME280 alone prints a different supply current for
 * humidity, pressure and temperature measurement, plus low-power application
 * figures on another page. Those are distinct states that a design may use
 * differently, so `name` carries what makes each row unique and is the row's
 * identity when specs are merged. `mode` is the coarse bucket a calculator
 * asks for. Collapsing the two loses every row but one.
 */
export const PowerState = z.object({
  /** distinguishing name, verbatim-ish from the datasheet row */
  name: z.string(),
  /** coarse bucket for calculators; absent when the row names no known mode */
  mode: PowerMode.optional(),
  current: SourcedRange,
  conditions: z.string().optional(),
});
export type PowerState = z.infer<typeof PowerState>;

/**
 * Canonical vocabulary for what a pin does — the shared language between
 * datasheet extraction, connection compatibility checks, and firmware pinmap
 * codegen. Kept here rather than in `ingest` because it is a domain fact, not
 * an extraction detail, and the web UI needs it without pulling in the PDF stack.
 */
export const PinFunction = z.enum([
  "supply",
  "ground",
  "i2c-sda",
  "i2c-scl",
  "i2c-address-select",
  "spi-sck",
  "spi-sdi",
  "spi-sdo",
  "spi-cs",
  "uart-tx",
  "uart-rx",
  "gpio",
  "analog-in",
  "reset",
  "interrupt",
  "nc",
]);
export type PinFunction = z.infer<typeof PinFunction>;

export const Pin = z.object({
  name: z.string(),
  number: z.string().optional(),
  /**
   * Deliberately lenient (not `PinFunction`): components committed before the
   * vocabulary existed, or hand-entered with a part-specific function name,
   * must still load. Extraction is where the enum is enforced — see
   * `ExtractedPin` — so new data is canonical without orphaning old rows.
   */
  functions: z.array(z.string()).default([]),
  /** e.g. "3.3V", "VDD-referenced", "5V-tolerant" */
  voltage: z.string().optional(),
});
export type Pin = z.infer<typeof Pin>;

export const ComponentInterface = z.object({
  kind: InterfaceKind,
  /** e.g. i2c address, spi max clock */
  attrs: z.record(z.union([z.string(), z.number(), SourcedValue])).default({}),
});
export type ComponentInterface = z.infer<typeof ComponentInterface>;

export const ComponentSpecs = z.object({
  absoluteMax: z.array(RatedParam).default([]),
  recommendedOperating: z.array(RatedParam).default([]),
  powerStates: z.array(PowerState).default([]),
  pins: z.array(Pin).default([]),
  interfaces: z.array(ComponentInterface).default([]),
  /** decoupling/bypass recommendation, verbatim-ish from datasheet */
  decoupling: z
    .array(z.object({ description: z.string(), value: SourcedValue.optional() }))
    .default([]),
  /** anything extracted that doesn't fit the typed buckets yet */
  extra: z.record(SourcedValue).default({}),
});
export type ComponentSpecs = z.infer<typeof ComponentSpecs>;

export const Component = z.object({
  id: z.string(),
  mpn: z.string().min(1),
  manufacturer: z.string().default(""),
  description: z.string().default(""),
  category: ComponentCategory.default("other"),
  lifecycle: Lifecycle.default("unknown"),
  specs: ComponentSpecs.default({}),
  /**
   * Most datasheets do not describe exactly one part. They describe a family:
   * STM32F103x8/xB enumerates dozens of orderable MPNs differing only in flash,
   * package and temperature grade; BMP280/BME280 share nearly every electrical
   * row; one die often carries different thermal limits per package. Modelling
   * one datasheet as one component silently collapses all of that.
   *
   * A variant points at its family via `familyId`; the family row holds the
   * shared specs and the variant holds ONLY what differs (see `resolveSpecs`).
   * This is a self-referencing tree, so nothing migrates: a standalone part
   * keeps `familyId: null` and `isFamily: false` and behaves exactly as before.
   */
  familyId: z.string().nullable().default(null),
  /** true when this row is a family template rather than an orderable part */
  isFamily: z.boolean().default(false),
  /** orderable code exactly as printed in the ordering-information table */
  orderingCode: z.string().optional(),
  /** what distinguishes this variant, e.g. { flash: "64 KB", package: "LQFP48" } */
  variantAttrs: z.record(z.string()).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Component = z.infer<typeof Component>;

/**
 * Effective specs for a variant: the family's specs with the variant's own
 * rows layered on top. Rows are matched by their identity key (`param` for
 * rated tables, `name` for power states and pins) so a variant that overrides
 * one row inherits every other, which is exactly how a family datasheet reads
 * — one shared table plus a handful of per-variant exceptions.
 *
 * Passing a standalone component (no family) returns its specs untouched.
 */
export function resolveSpecs(
  variant: Pick<Component, "specs">,
  family: Pick<Component, "specs"> | null | undefined,
): ComponentSpecs {
  if (!family) return variant.specs;

  const overrideBy = <T>(base: T[], over: T[], key: (row: T) => string): T[] => {
    const merged = new Map(base.map((row) => [key(row), row]));
    for (const row of over) merged.set(key(row), row);
    return [...merged.values()];
  };

  return {
    absoluteMax: overrideBy(family.specs.absoluteMax, variant.specs.absoluteMax, (r) => r.param),
    recommendedOperating: overrideBy(
      family.specs.recommendedOperating,
      variant.specs.recommendedOperating,
      (r) => r.param,
    ),
    powerStates: overrideBy(family.specs.powerStates, variant.specs.powerStates, (r) => r.name),
    pins: overrideBy(family.specs.pins, variant.specs.pins, (r) => r.name),
    interfaces: overrideBy(family.specs.interfaces, variant.specs.interfaces, (r) => r.kind),
    decoupling: variant.specs.decoupling.length > 0 ? variant.specs.decoupling : family.specs.decoupling,
    extra: { ...family.specs.extra, ...variant.specs.extra },
  };
}

/**
 * Layer datasheet-extracted specs onto a component that already exists.
 *
 * The two acquisition channels are good at different things and this function
 * encodes which one wins where. A bulk-imported KiCad skeleton carries an
 * accurate, complete pin list and nothing electrical; a datasheet extraction
 * carries the electrical tables and a pinout read off a PDF — the weakest,
 * most error-prone thing the extractor produces. So existing pins stay
 * authoritative and extracted pins are only used to fill a genuinely empty
 * list. Electrical rows go the other way: the datasheet is the only source
 * that has them, so it overrides row-by-row while leaving unrelated rows
 * (e.g. a hand-entered measurement) in place.
 */
function rangeSources(range: SourcedRange): ValueSource[] {
  return [range.min, range.typ, range.max]
    .filter((v): v is SourcedValue => v !== undefined)
    .map((v) => v.source)
    .filter((s): s is ValueSource => s !== undefined);
}

/** True when a range carries no min/typ/max value at all — no data to attribute. */
function hasNumericValue(range: SourcedRange): boolean {
  return range.min !== undefined || range.typ !== undefined || range.max !== undefined;
}

/**
 * Drop the rows a previous machine read of THIS datasheet contributed, so a
 * re-read replaces its own past work instead of accumulating on top of it.
 *
 * `mergeSpecs` unions rows by key, which is right when two different sources
 * each know something the other doesn't. It is wrong for the same extractor
 * reading the same PDF twice: the keys are the extractor's own row names, and
 * those names change whenever the extractor gets better at reading the page. A
 * re-read that used to name a row "IDDRX — FSK 4.8 kb/s" and now names it
 * "IDDRX — Receive mode — FSK 4.8 kb/s" writes a NEW row and leaves the old one
 * behind, so the part grows a stale duplicate at every version bump. Worse, the
 * names are not unique within a table — the SX1262 prints "FSK 4.8 kb/s" for
 * both its DC-DC and LDO receive groups — so the survivors collide and a row
 * silently acquires the other group's value. Measured on the real part: 17 rows
 * became 28, and a 4.2 mA row started reading 8 mA.
 *
 * Only unverified rows go. A value a human accepted in the review UI outranks
 * anything the extractor has to say and is never superseded by it — that is the
 * whole point of the trust ladder. Rows sourced from elsewhere (a KiCad import,
 * a hand-entered measurement, another datasheet) are untouched.
 *
 * PowerStates get one extra pass: a row whose `current` carries no min/typ/max
 * value at all has nothing to attribute to any datasheet, so the ordinary
 * "superseded" check (which keys off sources) never fires for it and it would
 * otherwise survive every supersede forever — a husk that renders as a power
 * state with no data (e.g. the SX1262's "(NSS, MOSI, SCK) — -"). Such husks are
 * dropped unconditionally. A row that DOES carry a real numeric value is never
 * dropped by this pass, even if that value is somehow missing a source — only
 * the ordinary supersede-by-source check can remove a row with real data.
 */
export function supersedeExtracted(specs: ComponentSpecs, datasheetId: string): ComponentSpecs {
  const superseded = (sources: ValueSource[]): boolean =>
    sources.length > 0 &&
    sources.every(
      (s) => s.kind === "datasheet" && s.datasheetId === datasheetId && s.verifiedBy !== "human",
    );

  const keepRated = (rows: RatedParam[]): RatedParam[] =>
    rows.filter((r) => !superseded(rangeSources(r.range)));

  return {
    ...specs,
    absoluteMax: keepRated(specs.absoluteMax),
    recommendedOperating: keepRated(specs.recommendedOperating),
    powerStates: specs.powerStates.filter(
      (r) => hasNumericValue(r.current) && !superseded(rangeSources(r.current)),
    ),
    decoupling: specs.decoupling.filter(
      (d) => !(d.value !== undefined && superseded([d.value.source])),
    ),
  };
}

export function mergeSpecs(existing: ComponentSpecs, incoming: ComponentSpecs): ComponentSpecs {
  const overrideBy = <T>(base: T[], over: T[], key: (row: T) => string): T[] => {
    const merged = new Map(base.map((row) => [key(row), row]));
    for (const row of over) merged.set(key(row), row);
    return [...merged.values()];
  };

  return {
    absoluteMax: overrideBy(existing.absoluteMax, incoming.absoluteMax, (r) => r.param),
    recommendedOperating: overrideBy(
      existing.recommendedOperating,
      incoming.recommendedOperating,
      (r) => r.param,
    ),
    powerStates: overrideBy(existing.powerStates, incoming.powerStates, (r) => r.name),
    // KiCad pins win; extracted pins only fill an empty list
    pins: existing.pins.length > 0 ? existing.pins : incoming.pins,
    interfaces: overrideBy(existing.interfaces, incoming.interfaces, (r) => r.kind),
    decoupling: incoming.decoupling.length > 0 ? incoming.decoupling : existing.decoupling,
    extra: { ...existing.extra, ...incoming.extra },
  };
}

export const CreateComponentInput = Component.omit({
  id: true,
  createdAt: true,
  updatedAt: true,
}).partial({
  manufacturer: true,
  description: true,
  category: true,
  lifecycle: true,
  specs: true,
  familyId: true,
  isFamily: true,
  variantAttrs: true,
});
export type CreateComponentInput = z.infer<typeof CreateComponentInput>;

export const UpdateComponentInput = CreateComponentInput.partial();
export type UpdateComponentInput = z.infer<typeof UpdateComponentInput>;
