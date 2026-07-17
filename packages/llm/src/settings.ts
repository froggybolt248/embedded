import { z } from "zod";

export const TierModels = z.object({
  triage: z.string().min(1),
  extraction: z.string().min(1),
  assistant: z.string().min(1),
});
export type TierModels = z.infer<typeof TierModels>;

/**
 * Persisted LLM configuration (settings.json under the app data dir).
 * claude-code needs no key here — the Agent SDK reuses the Claude Code CLI
 * login, so usage bills to the user's Claude subscription.
 *
 * Ollama is the default: it is fully local, free, and leaves no datasheet or
 * design on someone else's server. claude-code is the fallback for when a task
 * outgrows the local models.
 */
export const LlmSettings = z.object({
  activeProvider: z.enum(["claude-code", "openai-compat", "ollama"]).default("ollama"),
  claudeCode: z
    .object({
      models: TierModels.default({
        triage: "claude-haiku-4-5-20251001",
        extraction: "claude-sonnet-5",
        assistant: "claude-sonnet-5",
      }),
    })
    .default({}),
  openaiCompat: z
    .object({
      baseUrl: z.string().default("https://api.openai.com/v1"),
      apiKey: z.string().default(""),
      models: TierModels.default({
        triage: "gpt-4o-mini",
        extraction: "gpt-4o",
        assistant: "gpt-4o",
      }),
    })
    .default({}),
  ollama: z
    .object({
      baseUrl: z.string().default("http://localhost:11434"),
      /**
       * Context window per request. Ollama's own default is 4096, which a
       * single vision extraction blows through instantly — four 150-DPI page
       * images plus their text layer measured 7626 tokens — and the server
       * answers with a hard HTTP 400 rather than truncating. 16384 fits that
       * comfortably while keeping the KV cache inside an ~8 GB GPU alongside a
       * 7B model. Raise it if you batch more pages; lower it if you run out of VRAM.
       */
      numCtx: z.number().int().min(2048).max(131072).default(16384),
      /**
       * Per-request ceiling. Local vision is genuinely slow — four 150-DPI page
       * images through a 7B model on an 8 GB laptop GPU measured 90–300 s per
       * request — so this must be generous enough not to abort real work, while
       * never being unbounded (an unbounded request is the hang this replaced).
       */
      requestTimeoutSec: z.number().int().min(30).max(3600).default(900),
      /**
       * Defaults sized for a single ~8 GB consumer GPU, and pinned to explicit
       * tags so a pull is reproducible. `extraction` MUST be a vision model —
       * datasheet pages are sent as images. Reusing one model for triage and
       * assistant avoids evicting/reloading weights between tiers.
       */
      models: TierModels.default({
        triage: "qwen3:4b",
        extraction: "qwen2.5vl:7b",
        assistant: "qwen3:4b",
      }),
    })
    .default({}),
});
export type LlmSettings = z.infer<typeof LlmSettings>;

export function defaultLlmSettings(): LlmSettings {
  return LlmSettings.parse({});
}
