import { z } from "zod";
import type { LlmProvider } from "@embedded/llm";
import { QuantifiedRequirement } from "@embedded/core";

/**
 * Proposes a machine-checkable `QuantifiedRequirement` from a free-text
 * requirement (e.g. "runs a year on a coin cell" -> { param:
 * "batteryLifeYears", op: ">=", value: 1, unit: "years" }).
 *
 * MODELED EXACTLY ON `proposeWakeInterval` (see wake-proposal.ts): this is a
 * PROPOSAL the user must accept, never a fact recorded on the requirement.
 * The LLM boundary schema is the only contract that holds — `param` and
 * `unit` are shape-constrained by zod so the model is structurally unable to
 * return free-form junk, but nothing here guarantees the proposal is
 * SEMANTICALLY correct. A wrong-but-plausible guess is worse than no guess,
 * so any schema-invalid output, provider error, or missing provider returns
 * null rather than a coerced or partial value.
 */

export interface QuantifyInput {
  text: string;
  kind?: string | undefined;
  /** The project archetype's stated power goal, when trivially available. */
  powerTarget?: { batteryCapacityMah?: number; minLifeYears?: number } | undefined;
}

// A short machine identifier — the same shape a code identifier would take —
// so downstream calculators can key off it without sanitizing free text.
const Param = z
  .string()
  .trim()
  .regex(/^[a-zA-Z][a-zA-Z0-9_]{0,39}$/, "param must be a short machine identifier");

const Unit = z.string().trim().min(1).max(16);

const QuantifyProposalSchema = QuantifiedRequirement.extend({
  param: Param,
  unit: Unit,
  value: z.number().finite(),
});

function buildPrompt(input: QuantifyInput): string {
  const lines: string[] = [
    `Requirement: ${input.text}`,
    `Kind: ${input.kind ?? "(none given)"}`,
  ];
  if (input.powerTarget) {
    const { batteryCapacityMah, minLifeYears } = input.powerTarget;
    lines.push(
      `Project power target: ${
        batteryCapacityMah !== undefined ? `${batteryCapacityMah} mAh battery` : "(no battery given)"
      }${minLifeYears !== undefined ? `, ${minLifeYears} year life target` : ""}`,
    );
  }
  lines.push(
    "",
    "Turn this requirement into the single most load-bearing measurable bound: what one " +
      "number, with what comparison, would tell you whether the design meets this requirement?",
    "",
    "`param` must be a short machine identifier (letters, digits, underscore, starting with a " +
      "letter) — prefer standard engineering parameter names where they fit, e.g. avgCurrent, " +
      "batteryLifeYears, mass, cost, peakCurrent, standbyCurrent, bootTimeMs.",
    "`op` is one of <=, >=, ==, <, >.",
    "`value` is a finite number in the units you choose.",
    "`unit` is a short unit string (max 16 characters), e.g. µA, years, g, USD, ms.",
  );
  return lines.join("\n");
}

/**
 * Ask the model to quantify a free-text requirement. Returns null — never a
 * guessed fallback — whenever the answer cannot be trusted: no provider
 * configured, the provider throws, or the response fails schema validation.
 *
 * Calls the provider's `extract` exactly once, at the "assistant" tier, same
 * as `proposeWakeInterval` — providers already retry once internally on a
 * schema-validation failure.
 */
export async function proposeQuantification(
  provider: LlmProvider | undefined,
  input: QuantifyInput,
): Promise<QuantifiedRequirement | null> {
  if (!provider) return null;

  try {
    const result = await provider.extract("assistant", {
      schema: QuantifyProposalSchema,
      schemaName: "quantify-requirement",
      system:
        "You turn a free-text hardware requirement into a single machine-checkable bound " +
        "(param, comparison, value, unit). Propose the ONE most load-bearing quantity — do " +
        "not try to capture every nuance of the requirement.",
      prompt: buildPrompt(input),
    });
    return result.data;
  } catch {
    return null;
  }
}
