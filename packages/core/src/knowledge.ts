import { z } from "zod";
import { ComponentCategory, DutyCycle, PowerMode } from "./component.js";
import { BlockRole } from "./design.js";

/**
 * Re-exported for back compat: existing code imports `DutyCycle` from here
 * (or from `@embedded/core`, which re-exports both). The definition itself
 * lives in `component.ts` to avoid a design.ts <-> knowledge.ts import cycle
 * — see the comment there.
 */
export { DutyCycle };

/**
 * Data-defined design rule. `when`/`assert` are expressions evaluated by the
 * sandboxed mathjs evaluator (M4) over a scope of project/component fields.
 * `builtin: true` entries resolve to registered TS functions instead —
 * identical shape, so both kinds render the same in the UI.
 */
export const DesignRule = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(""),
  severity: z.enum(["info", "warning", "error"]).default("warning"),
  /** selector over blocks/connections, e.g. { interface: "i2c" } */
  appliesTo: z.record(z.string()).default({}),
  check: z.object({
    when: z.string().default("true"),
    assert: z.string(),
    message: z.string(),
  }),
  /** citation for WHY this rule exists (app note, datasheet, textbook) */
  citation: z.string().optional(),
  enabled: z.boolean().default(true),
  builtin: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type DesignRule = z.infer<typeof DesignRule>;

/** What a rule was checked against — a block, a connection, or the design itself. */
export const FindingSubject = z.object({
  kind: z.enum(["block", "connection", "project"]),
  id: z.string(),
  /** human label for the UI, e.g. "MCU → Environment sensor (i2c)" */
  label: z.string(),
});
export type FindingSubject = z.infer<typeof FindingSubject>;

/**
 * Why a rule produced a finding. Three genuinely different things, which a
 * boolean would collapse into one:
 *
 * - `failed` — the rule ran and the design does not satisfy it. The real result.
 * - `needs-input` — the rule is fine, the DESIGN has not said enough yet (no bus
 *   capacitance, no bound part). Not an error and not a pass: it is the app
 *   telling the user which fact would unlock a check. Uncited gaps are honest.
 * - `broken` — the rule itself cannot run: a malformed expression, a `builtin`
 *   with no registered code. A bug in the rule, not in the design.
 *
 * Collapsing `needs-input` into `broken` cries wolf on every incomplete design;
 * collapsing it into silence hides a check that never ran. Both are worse than
 * saying plainly which one this is.
 */
export const FindingStatus = z.enum(["failed", "needs-input", "broken"]);
export type FindingStatus = z.infer<typeof FindingStatus>;

/**
 * One rule's verdict on one subject.
 *
 * `scope` is the finding's provenance: the exact values the rule saw. A finding
 * that says "pull-up too weak" and cannot show the numbers behind it is an
 * assertion, not evidence, and this app's whole premise is that a claim carries
 * its inputs. It is also what makes a wrong finding debuggable rather than
 * mysterious.
 *
 * A check that silently fails to run reads exactly like a check that passed,
 * which is the most dangerous state a verification tool can be in — so anything
 * other than a clean pass produces a finding saying which.
 */
export const Finding = z.object({
  ruleId: z.string(),
  ruleName: z.string(),
  severity: z.enum(["info", "warning", "error"]),
  message: z.string(),
  subject: FindingSubject,
  citation: z.string().optional(),
  scope: z.record(z.union([z.number(), z.boolean()])).default({}),
  status: FindingStatus.default("failed"),
  /** the scope values `needs-input` is waiting on; empty otherwise */
  missingInputs: z.array(z.string()).default([]),
});
export type Finding = z.infer<typeof Finding>;

export const CalculatorInput = z.object({
  name: z.string(),
  label: z.string(),
  unit: z.string(),
  /** optional path into bound component specs to prefill from the library */
  libraryPath: z.string().optional(),
  default: z.number().optional(),
});

export const Calculator = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(""),
  inputs: z.array(CalculatorInput).default([]),
  /** outputName → mathjs expression (unit-aware); ignored when builtin */
  formula: z.record(z.string()).default({}),
  outputs: z
    .array(z.object({ name: z.string(), label: z.string(), unit: z.string() }))
    .default([]),
  citation: z.string().optional(),
  builtin: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Calculator = z.infer<typeof Calculator>;

/** A persisted, citable execution of a calculator. */
export const CalculatorRun = z.object({
  id: z.string(),
  calculatorId: z.string(),
  projectId: z.string().nullable().default(null),
  inputs: z.record(z.number()),
  outputs: z.record(z.number()),
  createdAt: z.string(),
});
export type CalculatorRun = z.infer<typeof CalculatorRun>;

/**
 * How an archetype points at a part WITHOUT naming one.
 *
 * Hardcoding MPNs was the obvious design and it is wrong: a library's naming is
 * its own business. Measured against the real 22.7k-part KiCad import, half of
 * a hand-written shortlist missed — the parts are there, but as
 * `Pololu_Breakout_DRV8825`, `TMC2209-LA`, `MCP73831-2-OT`. A recipe that
 * names exact MPNs is broken on day one and rots further as libraries change.
 *
 * So a recipe describes the SEARCH a designer would run, and the library
 * answers it. `prefer` lists MPNs known to exist and to be good picks; they are
 * pinned first when present and simply absent when they are not, which
 * degrades to a plain search instead of an empty list.
 */
export const PartHint = z.object({
  /** free-text query over mpn/manufacturer/description */
  q: z.string().optional(),
  category: ComponentCategory.optional(),
  /** known-good MPNs, pinned to the top when the library has them */
  prefer: z.array(z.string()).default([]),
});
export type PartHint = z.infer<typeof PartHint>;

export const SuggestedBlock = z.object({
  name: z.string(),
  role: BlockRole,
  /** one line on WHY this block exists — the teaching surface */
  hint: z.string().optional(),
  pick: PartHint.default({}),
  /** starting duty per mode for this block, overriding the role default */
  duty: z.record(PowerMode, DutyCycle).optional(),
});
export type SuggestedBlock = z.infer<typeof SuggestedBlock>;

/**
 * One step in the Bring-up phase checklist — the archetype-specific "what to
 * check before you trust this board" list, distinct from the plain-string
 * `phaseChecklists.bringup` above because a bring-up step earns a `hint`: the
 * one-line WHY, same teaching surface as `SuggestedBlock.hint`.
 */
export const BringUpStep = z.object({
  text: z.string(),
  hint: z.string().optional(),
});
export type BringUpStep = z.infer<typeof BringUpStep>;

/** The quantified goal the archetype exists to hit, checkable against a budget. */
export const PowerTarget = z.object({
  batteryCapacityMah: z.number().positive(),
  /** what the battery is, in words, e.g. "CR2032 coin cell" */
  batteryLabel: z.string().default(""),
  minLifeYears: z.number().positive().optional(),
});
export type PowerTarget = z.infer<typeof PowerTarget>;

export const Archetype = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(""),
  recipe: z
    .object({
      suggestedBlocks: z.array(SuggestedBlock).default([]),
      /** the power goal this build is judged against */
      powerTarget: PowerTarget.optional(),
      ruleIds: z.array(z.string()).default([]),
      calculatorIds: z.array(z.string()).default([]),
      /** per-phase checklists, e.g. bringup: ["verify 3V3 before MCU", …] */
      phaseChecklists: z.record(z.array(z.string())).default({}),
      /**
       * The Bring-up phase checklist, richer than `phaseChecklists.bringup`:
       * each step can carry a `hint` explaining why it matters. Optional —
       * an archetype with no bring-up steps just renders no checklist, not a
       * broken one.
       */
      bringUpChecklist: z.array(BringUpStep).optional(),
    })
    .default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Archetype = z.infer<typeof Archetype>;

export const FirmwareArtifact = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(["pinmap-header", "platformio-ini", "skeleton"]),
  filename: z.string(),
  content: z.string(),
  /** what it was generated from, for regeneration + provenance */
  generatedFrom: z.record(z.unknown()).default({}),
  createdAt: z.string(),
});
export type FirmwareArtifact = z.infer<typeof FirmwareArtifact>;
