import type { TierModels } from "./settings.js";

/**
 * Which local-model set to offer at setup, given what the host can actually
 * run. The onboarding screen sends this straight to a one-click pull, so the
 * defaults must be tags that exist on the Ollama registry AND fit the reported
 * memory — a recommendation that OOMs or 404s is worse than none.
 *
 * `extraction` MUST be a vision model: datasheet pages are sent as images. The
 * triage/assistant tiers reuse one small text model so switching tiers doesn't
 * evict weights.
 */
export type Accelerator = "cuda" | "metal" | "cpu";

/** Approx download size per tag, GB — for showing "you're about to pull N GB". */
export const OLLAMA_MODEL_SIZES_GB: Record<string, number> = {
  "qwen3:1.7b": 1.4,
  "qwen3:4b": 2.6,
  "qwen2.5vl:3b": 3.2,
  "qwen2.5vl:7b": 6.0,
};

export type RecommendationTier = "standard" | "compact";

export interface OllamaRecommendation {
  tier: RecommendationTier;
  models: TierModels;
  /** the distinct tags that a pull would download, in pull order */
  uniqueModels: string[];
  /** total approximate download, GB */
  downloadGb: number;
  /** one honest sentence about how this will run here */
  note: string;
}

const STANDARD: TierModels = {
  triage: "qwen3:4b",
  extraction: "qwen2.5vl:7b",
  assistant: "qwen3:4b",
};
const COMPACT: TierModels = {
  triage: "qwen3:1.7b",
  extraction: "qwen2.5vl:3b",
  assistant: "qwen3:1.7b",
};

function uniqueOf(models: TierModels): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  // extraction (the vision model, the big one) first so a slow pull surfaces early
  for (const tag of [models.extraction, models.triage, models.assistant]) {
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }
  return out;
}

function downloadGbOf(unique: string[]): number {
  const total = unique.reduce((sum, tag) => sum + (OLLAMA_MODEL_SIZES_GB[tag] ?? 0), 0);
  return Math.round(total * 10) / 10;
}

/**
 * The 7B vision model needs roughly 7–8 GB of memory to run with a working
 * context; below that we step down to the 3B vision + 1.7B text set, which is
 * also the only sane choice when there is no GPU and everything runs on the CPU.
 */
export function recommendOllamaModels(
  budgetGb: number,
  accelerator: Accelerator,
): OllamaRecommendation {
  const canRunStandard = accelerator !== "cpu" && budgetGb >= 7;
  const tier: RecommendationTier = canRunStandard ? "standard" : "compact";
  const models = canRunStandard ? STANDARD : COMPACT;
  const uniqueModels = uniqueOf(models);

  let note: string;
  if (accelerator === "cuda") {
    note = canRunStandard
      ? `Runs on your GPU (${budgetGb} GB VRAM) — comfortable for the 7B vision model.`
      : `Your GPU has ${budgetGb} GB VRAM, so this uses the compact models to stay within it.`;
  } else if (accelerator === "metal") {
    note = "Runs on Apple silicon using unified memory.";
  } else {
    note =
      "No supported GPU detected — models run on the CPU, which is noticeably slower. " +
      "The compact set keeps it usable; switch to a cloud provider if you need speed.";
  }

  return { tier, models, uniqueModels, downloadGb: downloadGbOf(uniqueModels), note };
}
