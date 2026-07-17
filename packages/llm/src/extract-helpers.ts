import { LlmError, type ExtractRequest, type ExtractResult, type LlmUsage } from "./types.js";
import { toJsonSchema } from "./json-schema.js";

export function jsonInstruction(schema: Record<string, unknown>): string {
  return [
    "Respond with a single JSON object and nothing else — no prose, no markdown fences.",
    "The object must validate against this JSON Schema:",
    JSON.stringify(schema),
  ].join("\n");
}

/** Tolerant JSON pull: strips code fences, then takes the outermost {...} or [...]. */
export function parseJsonLoose(text: string): unknown {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence?.[1]) t = fence[1].trim();
  const start = t.search(/[[{]/);
  if (start > 0) t = t.slice(start);
  const lastBrace = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (lastBrace >= 0) t = t.slice(0, lastBrace + 1);
  try {
    return JSON.parse(t);
  } catch (err) {
    throw new LlmError(`model output is not valid JSON: ${text.slice(0, 300)}`, err);
  }
}

export interface AttemptOutput {
  raw: string;
  /** provider-parsed structured output, when the provider enforces the schema natively */
  parsed?: unknown;
  model: string;
  usage?: LlmUsage;
}

/**
 * Shared extract loop: attempt → zod-validate → on failure retry ONCE with
 * the validation errors appended → validate or throw. Providers supply the
 * transport; this owns the retry contract from the plan.
 */
export async function extractWithRetry<T>(
  req: ExtractRequest<T>,
  attempt: (repairInstruction?: string) => Promise<AttemptOutput>,
): Promise<ExtractResult<T>> {
  const first = await attempt();
  const firstCandidate = first.parsed !== undefined ? first.parsed : parseJsonLooseSafe(first.raw);
  const firstTry = req.schema.safeParse(firstCandidate);
  if (firstTry.success) {
    const out: ExtractResult<T> = {
      data: firstTry.data,
      model: first.model,
      raw: first.raw,
      retried: false,
    };
    if (first.usage) out.usage = first.usage;
    return out;
  }

  const issues = firstTry.error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
  const second = await attempt(
    `Your previous response failed schema validation: ${issues}. ` +
      `Previous response: ${first.raw.slice(0, 2000)}. ` +
      `Return a corrected JSON object only.`,
  );
  const secondCandidate = second.parsed !== undefined ? second.parsed : parseJsonLoose(second.raw);
  const secondTry = req.schema.safeParse(secondCandidate);
  if (!secondTry.success) {
    throw new LlmError(
      `extraction "${req.schemaName}" failed validation after retry: ${secondTry.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ")}`,
    );
  }
  const out: ExtractResult<T> = {
    data: secondTry.data,
    model: second.model,
    raw: second.raw,
    retried: true,
  };
  if (second.usage) out.usage = second.usage;
  return out;
}

function parseJsonLooseSafe(text: string): unknown {
  try {
    return parseJsonLoose(text);
  } catch {
    // let the zod failure drive the retry with a useful message
    return undefined;
  }
}

export function promptSchemaFor<T>(req: ExtractRequest<T>): Record<string, unknown> {
  return toJsonSchema(req.schema);
}
