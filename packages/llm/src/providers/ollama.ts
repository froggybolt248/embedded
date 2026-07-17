import {
  LlmError,
  type ExtractRequest,
  type ExtractResult,
  type LlmCapabilities,
  type LlmImage,
  type LlmProvider,
  type LlmUsage,
  type ModelTier,
  type ProviderHealth,
  type StreamEvent,
  type StreamRequest,
} from "../types.js";
import { extractWithRetry, promptSchemaFor, type AttemptOutput } from "../extract-helpers.js";
import { MODEL_TIERS } from "../types.js";
import type { LlmSettings } from "../settings.js";

interface OllamaMessage {
  role: "system" | "user";
  content: string;
  images?: string[];
}

/** Ollama reports per-model capabilities from /api/show. */
export interface OllamaModelInfo {
  name: string;
  capabilities: string[];
}

/** reachability + metadata: must fail fast, it gates the Settings "Test" spinner */
const META_TIMEOUT_MS = 5_000;

/**
 * Local Ollama server. Structured output uses Ollama's native `format`
 * field, which takes a JSON schema directly. Vision models (llava,
 * qwen2.5vl…) take base64 images on the message.
 */
export class OllamaProvider implements LlmProvider {
  readonly kind = "ollama" as const;
  /** /api/show result per model — capabilities don't change while we run */
  private readonly capsCache = new Map<string, string[]>();

  constructor(private readonly config: LlmSettings["ollama"]) {}

  modelFor(tier: ModelTier): string {
    return this.config.models[tier];
  }

  capabilities(): LlmCapabilities {
    return { vision: true, structuredOutput: "native" };
  }

  /** cheap: /api/show only, no generation — safe to call before a long pipeline */
  async preflight(tier: ModelTier, need: { vision?: boolean }): Promise<void> {
    const model = this.modelFor(tier);
    const caps = await this.modelCapabilities(model);
    if (need.vision && !caps.includes("vision")) {
      throw new LlmError(visionError(model, caps));
    }
  }

  async extract<T>(tier: ModelTier, req: ExtractRequest<T>): Promise<ExtractResult<T>> {
    const schema = promptSchemaFor(req);
    const model = this.modelFor(tier);
    const caps = await this.modelCapabilities(model);

    if (req.images?.length && !caps.includes("vision")) {
      throw new LlmError(visionError(model, caps));
    }

    return extractWithRetry(req, async (repairInstruction): Promise<AttemptOutput> => {
      const prompt = repairInstruction ? `${req.prompt}\n\n${repairInstruction}` : req.prompt;
      const body = await this.post(
        "/api/chat",
        {
          model,
          messages: buildMessages(req.system, prompt, req.images),
          format: schema,
          stream: false,
          options: { num_ctx: this.config.numCtx },
          // Reasoning models otherwise burn minutes of thinking tokens before
          // emitting the JSON — measured 45.6 s vs 1.7 s on qwen3:4b, identical
          // output. The schema is the contract here; the monologue buys nothing.
          ...(caps.includes("thinking") ? { think: false } : {}),
        },
        this.chatTimeoutMs(),
      );
      const parsed = body as {
        message?: { content?: string };
        prompt_eval_count?: number;
        eval_count?: number;
      };
      const raw = parsed.message?.content ?? "";
      if (!raw) throw new LlmError(`ollama model "${model}" returned an empty message`);
      const out: AttemptOutput = { raw, model };
      const usage: LlmUsage = {};
      if (parsed.prompt_eval_count !== undefined) usage.inputTokens = parsed.prompt_eval_count;
      if (parsed.eval_count !== undefined) usage.outputTokens = parsed.eval_count;
      if (usage.inputTokens !== undefined || usage.outputTokens !== undefined) out.usage = usage;
      return out;
    });
  }

  async *stream(tier: ModelTier, req: StreamRequest): AsyncIterable<StreamEvent> {
    const model = this.modelFor(tier);
    const caps = await this.modelCapabilities(model);
    const res = await fetch(this.url("/api/chat"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model,
        messages: buildMessages(req.system, req.prompt, req.images),
        stream: true,
        options: { num_ctx: this.config.numCtx },
        ...(caps.includes("thinking") ? { think: false } : {}),
      }),
      signal: AbortSignal.timeout(this.chatTimeoutMs()),
    }).catch((err) => {
      throw this.reachError(err, this.chatTimeoutMs());
    });
    if (!res.ok || !res.body) {
      throw new LlmError(`ollama /api/chat failed: HTTP ${res.status}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line) continue;
        try {
          const json = JSON.parse(line) as { message?: { content?: string }; done?: boolean };
          const text = json.message?.content;
          if (text) yield { type: "text", text };
        } catch {
          // partial line — ignore
        }
      }
    }
    yield { type: "done", model };
  }

  /**
   * Reports the server version AND whether each tier's configured model is
   * actually pulled, because "Ollama is up" is not the question the user is
   * asking — every real failure so far has been a model that isn't installed
   * or can't see images.
   */
  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    let version: string;
    try {
      const res = await fetch(this.url("/api/version"), {
        signal: AbortSignal.timeout(META_TIMEOUT_MS),
      });
      if (!res.ok) {
        return { ok: false, detail: `HTTP ${res.status}`, latencyMs: Date.now() - started };
      }
      const body = (await res.json()) as { version?: string };
      version = body.version ?? "?";
    } catch (err) {
      return {
        ok: false,
        detail: `cannot reach ${this.config.baseUrl} — is Ollama running? (${errText(err)})`,
        latencyMs: Date.now() - started,
      };
    }

    const problems: string[] = [];
    for (const tier of MODEL_TIERS) {
      const model = this.modelFor(tier);
      let caps: string[];
      try {
        caps = await this.modelCapabilities(model);
      } catch (err) {
        problems.push(`${tier}: ${errText(err)}`);
        continue;
      }
      if (tier === "extraction" && !caps.includes("vision")) {
        problems.push(`extraction: ${visionError(model, caps)}`);
      }
    }

    if (problems.length > 0) {
      return {
        ok: false,
        detail: `ollama ${version} reachable, but: ${problems.join(" · ")}`,
        latencyMs: Date.now() - started,
      };
    }
    return {
      ok: true,
      detail: `ollama ${version} reachable · all tier models installed`,
      latencyMs: Date.now() - started,
    };
  }

  /** Installed models with their capabilities — powers the Settings model picker. */
  async listModels(): Promise<OllamaModelInfo[]> {
    const body = (await this.get("/api/tags")) as { models?: Array<{ name?: string }> };
    const names = (body.models ?? []).map((m) => m.name).filter((n): n is string => !!n);
    const out: OllamaModelInfo[] = [];
    for (const name of names.sort((a, b) => a.localeCompare(b))) {
      try {
        out.push({ name, capabilities: await this.modelCapabilities(name) });
      } catch {
        out.push({ name, capabilities: [] });
      }
    }
    return out;
  }

  /**
   * Capabilities for one model, or an actionable error when it isn't pulled.
   * Ollama answers a missing model with a bare `HTTP 404 model not found`,
   * which surfaced to the user as an unexplained red box.
   */
  private async modelCapabilities(model: string): Promise<string[]> {
    const cached = this.capsCache.get(model);
    if (cached) return cached;

    const res = await fetch(this.url("/api/show"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
    }).catch((err) => {
      throw this.reachError(err, META_TIMEOUT_MS);
    });

    if (res.status === 404) {
      throw new LlmError(
        `ollama model "${model}" is not installed. Run \`ollama pull ${model}\`, ` +
          `or pick an installed model in Settings.`,
      );
    }
    if (!res.ok) {
      throw new LlmError(`ollama /api/show failed for "${model}": HTTP ${res.status}`);
    }
    const body = (await res.json()) as { capabilities?: string[] };
    const caps = body.capabilities ?? [];
    this.capsCache.set(model, caps);
    return caps;
  }

  private chatTimeoutMs(): number {
    return this.config.requestTimeoutSec * 1000;
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private reachError(err: unknown, timeoutMs: number): LlmError {
    if (err instanceof Error && err.name === "TimeoutError") {
      return new LlmError(
        `ollama did not respond within ${Math.round(timeoutMs / 1000)}s. Local vision extraction ` +
          `is slow — raise "Request timeout" in Settings → Ollama, or use a smaller model.`,
        err,
      );
    }
    return new LlmError(`cannot reach ${this.config.baseUrl}: ${errText(err)}`, err);
  }

  private async get(path: string): Promise<unknown> {
    const res = await fetch(this.url(path), {
      signal: AbortSignal.timeout(META_TIMEOUT_MS),
    }).catch((err) => {
      throw this.reachError(err, META_TIMEOUT_MS);
    });
    if (!res.ok) throw new LlmError(`ollama ${path} failed: HTTP ${res.status}`);
    return res.json();
  }

  private async post(
    path: string,
    payload: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    const res = await fetch(this.url(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    }).catch((err) => {
      throw this.reachError(err, timeoutMs);
    });
    if (!res.ok) {
      let detail = "";
      try {
        detail = (await res.text()).slice(0, 300);
      } catch {
        /* ignore */
      }
      // Ollama reports an over-long prompt as a raw 400 with nested JSON. Turn
      // the one failure a user can actually act on into an instruction.
      if (detail.includes("exceed_context_size") || detail.includes("exceeds the available context")) {
        const needed = /\((\d+) tokens\)/.exec(detail)?.[1];
        throw new LlmError(
          `the request${needed ? ` (${needed} tokens)` : ""} is larger than the configured Ollama ` +
            `context size (num_ctx = ${this.config.numCtx}). Raise "Context size" in Settings → ` +
            `Ollama, or use a datasheet with fewer pages per section.`,
        );
      }
      throw new LlmError(`ollama ${path} failed: HTTP ${res.status} ${detail}`);
    }
    return res.json();
  }
}

function visionError(model: string, caps: string[]): string {
  return (
    `ollama model "${model}" cannot read images (capabilities: ${caps.join(", ") || "none"}), ` +
    `but datasheet extraction sends page images. Pull a vision model and set it as the ` +
    `extraction model — e.g. \`ollama pull qwen2.5vl:7b\`.`
  );
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function buildMessages(
  system: string | undefined,
  prompt: string,
  images?: LlmImage[],
): OllamaMessage[] {
  const messages: OllamaMessage[] = [];
  if (system) messages.push({ role: "system", content: system });
  const user: OllamaMessage = { role: "user", content: prompt };
  if (images && images.length > 0) user.images = images.map((i) => i.dataBase64);
  messages.push(user);
  return messages;
}
