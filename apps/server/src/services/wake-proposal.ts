import { z } from "zod";
import type { LlmProvider } from "@embedded/llm";
import { DEFAULT_INTERVALS, intervalLabel } from "@embedded/calc";

/**
 * Proposes a starting wake cadence (`everySec`) from the PROJECT's context —
 * archetype, blocks — so the "how often should this wake up?" question is
 * shown with a sensible default instead of a blank field.
 *
 * THIS IS AN ASSUMPTION, NOT A FACT, AND MUST NEVER BE RECORDED AS A
 * `SourcedValue`/citation. The governing distinction for this whole app:
 *
 *   `forMs`    — how long a part stays awake per cycle. Usually a DATASHEET
 *                FACT (startup time, conversion time). Groundable, citable.
 *   `everySec` — how often YOUR design wakes. Not a fact about any part. No
 *                datasheet knows it, and an LLM "estimating" it is guessing
 *                the designer's intent, not reading anything.
 *
 * So what comes back from `proposeWakeInterval` is a SUGGESTION to populate a
 * question the user can accept, edit, or ignore — it must never be attached
 * to a component spec, never cited as a datasheet value, and never presented
 * as anything other than "we guessed; tell us if we're wrong." A caller that
 * stores this in the same place as a grounded number would recreate the exact
 * failure mode this app exists to prevent (a confidently-cited invented
 * figure) one layer up, at the product level instead of the part level.
 */

export interface WakeProposalInput {
  projectName: string;
  archetypeName?: string | undefined;
  blocks: Array<{ name: string; role: string; mpn?: string | undefined }>;
}

export interface WakeProposal {
  everySec: number;
  reason: string;
}

// Hard-won lesson in this codebase (learned twice): the LLM boundary schema
// is the only contract that holds across runs — prompt-only instructions do
// NOT. `everySec` is therefore constrained to DEFAULT_INTERVALS by the zod
// schema itself, so the model is structurally unable to return an off-ladder
// value like 47. If it somehow still does (or fails validation any other
// way), `proposeWakeInterval` returns null rather than coercing or snapping
// to the nearest rung — a wrong-but-plausible guess is worse than no guess.
const EverySecLiterals = DEFAULT_INTERVALS.map((s) => z.literal(s)) as [
  z.ZodLiteral<number>,
  z.ZodLiteral<number>,
  ...z.ZodLiteral<number>[],
];
const EverySec = z.union(EverySecLiterals);

// The reason must stay at product altitude ("a weather station's readings
// change slowly"), never electrical ("this saves power") — the app prices
// the electrical consequence itself via `intervalTradeoff`, and a model
// asserting a current/battery-life number here would be exactly the
// confidently-cited-wrong-number failure this app exists to prevent. The
// regex below rejects any reason that pairs a digit with a
// current/charge/energy/duration unit (e.g. "2 years", "150 µA", "3 mAh"),
// which covers battery-life and current claims without needing the model to
// police itself.
const BATTERY_OR_CURRENT_CLAIM =
  /\d+(\.\d+)?\s*(m?a|µa|ua|na|mah|ah|wh|mwh|kwh|years?|yrs?|months?|weeks?|days?|hours?|hrs?)\b/i;

const WakeProposalSchema = z.object({
  everySec: EverySec,
  reason: z
    .string()
    .trim()
    .min(1)
    .max(140)
    .refine((r) => !BATTERY_OR_CURRENT_CLAIM.test(r), {
      message: "reason must not assert a current or battery-life figure",
    }),
});

function buildPrompt(input: WakeProposalInput): string {
  const lines: string[] = [
    `Project: ${input.projectName}`,
    input.archetypeName ? `Archetype: ${input.archetypeName}` : `Archetype: (none given)`,
    "Blocks:",
  ];
  if (input.blocks.length === 0) {
    lines.push("  (none given)");
  } else {
    for (const b of input.blocks) {
      lines.push(`  - ${b.name} (${b.role}${b.mpn ? `, ${b.mpn}` : ""})`);
    }
  }
  lines.push(
    "",
    "Propose how often this device should wake up to do its job, based on what " +
      "the PRODUCT needs to sense or report — not on power consumption or battery " +
      "life, which are computed separately and must not appear in your answer.",
    "",
    "Choose `everySec` from exactly these options (seconds): " +
      DEFAULT_INTERVALS.map((s) => `${s} (${intervalLabel(s)})`).join(", ") +
      ".",
    "`reason` must be one plain sentence about the product's use case, under 140 characters, " +
      "and must not state any current, charge, energy, or battery-life figure.",
  );
  return lines.join("\n");
}

/**
 * Ask the model for a starting wake cadence. Returns null — never a guessed
 * fallback — whenever the answer cannot be trusted: no provider configured,
 * the provider throws (including auth failures), or the response fails
 * schema validation. A null result is the correct, honest outcome: the
 * caller simply shows the question with no pre-filled suggestion.
 *
 * Calls the provider's `extract` exactly once. Providers already retry once
 * internally on a schema-validation failure (see `extractWithRetry` in
 * `@embedded/llm`); adding a second retry layer here would just be guessing
 * harder.
 */
export async function proposeWakeInterval(
  provider: LlmProvider | undefined,
  input: WakeProposalInput,
): Promise<WakeProposal | null> {
  if (!provider) return null;

  try {
    const result = await provider.extract("assistant", {
      schema: WakeProposalSchema,
      schemaName: "wake-proposal",
      system:
        "You help propose a starting point for a hardware design question. You are not " +
        "reading a datasheet and must not state any electrical figures (current, charge, " +
        "energy, or battery life) — only describe the product's use case.",
      prompt: buildPrompt(input),
    });
    return result.data;
  } catch {
    return null;
  }
}
