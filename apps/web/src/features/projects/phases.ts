import type { Block, Connection, Finding, Requirement } from "@embedded/core";
import type { BlockGrounding } from "../../lib/api";
import type { Tone } from "../../components/ui";

/**
 * The seven phases, linear, as data. `id` doubles as the workspace section's
 * DOM id (the phase rail scroll-spies these). Order is the build order.
 */
export const PHASES = [
  { id: "scope", label: "Scope", blurb: "What must it do" },
  { id: "architecture", label: "Architecture", blurb: "What is it made of" },
  { id: "components", label: "Components", blurb: "Which real parts" },
  { id: "electrical", label: "Electrical", blurb: "Does it hold up" },
  { id: "firmware", label: "Firmware", blurb: "Pins & skeleton" },
  { id: "bringup", label: "Bring-up", blurb: "First power-on" },
  { id: "optimize", label: "Optimize", blurb: "Measured vs estimated" },
] as const;

export type PhaseId = (typeof PHASES)[number]["id"];

export interface PhaseProgress {
  /** 0..1 — drives the ring. Kept coarse where fine precision would be a lie. */
  fraction: number;
  /** the ring/dot color: what state this phase is in */
  tone: Tone;
}

export interface ProgressInputs {
  requirements: Requirement[] | undefined;
  blocks: Block[] | undefined;
  connections: Connection[] | undefined;
  grounding: BlockGrounding[] | undefined;
  findings: Finding[] | undefined;
}

const EMPTY: PhaseProgress = { fraction: 0, tone: "neutral" };

/**
 * Derive per-phase completeness from the design as it stands. Deliberately
 * honest: a phase with no signal reads empty (neutral), not "done". Fractions
 * are only fine-grained where the ratio genuinely means something (how many
 * blocks are bound, how many are measured); elsewhere they're coarse
 * {0, 0.5, 1} so the ring never implies precision the data can't support.
 */
export function computeProgress(input: ProgressInputs): Record<PhaseId, PhaseProgress> {
  const reqs = input.requirements ?? [];
  const blocks = input.blocks ?? [];
  const connections = input.connections ?? [];
  const grounding = input.grounding ?? [];
  const findings = input.findings ?? [];

  const groundingByBlock = new Map(grounding.map((g) => [g.blockId, g]));
  const bound = blocks.filter((b) => b.componentId);
  const groundedBound = bound.filter((b) => {
    const s = groundingByBlock.get(b.id)?.status;
    return s === "grounded" || s === "partial";
  });
  const measured = blocks.filter((b) => Object.keys(b.measuredMa).length > 0);

  // Scope: no requirements → empty; some → in progress; any quantified → done.
  const scope: PhaseProgress =
    reqs.length === 0
      ? EMPTY
      : reqs.some((r) => r.quantified)
        ? { fraction: 1, tone: "ok" }
        : { fraction: 0.5, tone: "accent" };

  // Architecture: blocks sketched → half; wired together → done.
  const architecture: PhaseProgress =
    blocks.length === 0
      ? EMPTY
      : connections.length > 0
        ? { fraction: 1, tone: "ok" }
        : { fraction: 0.5, tone: "accent" };

  // Components: fraction of blocks bound to a real part.
  const components: PhaseProgress =
    blocks.length === 0
      ? EMPTY
      : {
          fraction: bound.length / blocks.length,
          tone: bound.length === blocks.length ? "ok" : "accent",
        };

  // Electrical: can the checks run, and do they pass? A failed finding pulls
  // the phase to warn even if everything is grounded — that's the point.
  const hasFailure = findings.some((f) => f.status === "failed" && f.severity !== "info");
  const electrical: PhaseProgress =
    bound.length === 0
      ? EMPTY
      : hasFailure
        ? { fraction: groundedBound.length / bound.length, tone: "warn" }
        : groundedBound.length === 0
          ? { fraction: 0.15, tone: "accent" }
          : {
              fraction: groundedBound.length / bound.length,
              tone: groundedBound.length === bound.length ? "ok" : "accent",
            };

  // Firmware / Bring-up have no persisted completion signal — they read as
  // "available" (a faint accent tick) once there's a design to act on, never
  // as done, because the app can't honestly claim the user finished them.
  const available: PhaseProgress =
    blocks.length > 0 ? { fraction: 0.5, tone: "accent" } : EMPTY;

  // Optimize: fraction of bound blocks the designer has entered a measurement for.
  const optimize: PhaseProgress =
    bound.length === 0
      ? EMPTY
      : measured.length === 0
        ? { fraction: 0.05, tone: "accent" }
        : {
            fraction: measured.length / bound.length,
            tone: measured.length === bound.length ? "ok" : "accent",
          };

  return {
    scope,
    architecture,
    components,
    electrical,
    firmware: available,
    bringup: available,
    optimize,
  };
}
