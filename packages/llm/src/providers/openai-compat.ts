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
import {
  extractWithRetry,
  jsonInstruction,
  promptSchemaFor,
  type AttemptOutput,
} from "../extract-helpers.js";
import type { LlmSettings } from "../settings.js";

interface ChatMessage {
  role: "system" | "user";
  content: string | Array<Record<string, unknown>>;
}

/** reachability check: must fail fast, it gates the Settings "Test" spinner */
const META_TIMEOUT_MS = 10_000;
/**
 * Generation ceiling. Remote APIs and local servers alike can stall; without a
 * bound the UI spins forever with no error. Generous, but never unbounded.
 */
const CHAT_TIMEOUT_MS = 300_000;

function reachError(baseUrl: string, err: unknown, timeoutMs: number): LlmError {
  if (err instanceof Error && err.name === "TimeoutError") {
    return new LlmError(
      `${baseUrl} did not respond within ${Math.round(timeoutMs / 1000)}s — ` +
        `the server may be overloaded or the model still loading.`,
      err,
    );
  }
  return new LlmError(`cannot reach ${baseUrl}: ${String(err)}`, err);
}

/**
 * Any OpenAI-compatible chat-completions server: OpenAI itself, LM Studio,
 * llama.cpp server, OpenRouter, vLLM… Tries native response_format
 * json_schema first and falls back to prompt-embedded schema, since support
 * varies across servers.
 */
export class OpenAICompatProvider implements LlmProvider {
  readonly kind = "openai-compat" as const;
  private nativeSchemaSupported: boolean | undefined;

  constructor(private readonly config: LlmSettings["openaiCompat"]) {}

  modelFor(tier: ModelTier): string {
    return this.config.models[tier];
  }

  capabilities(): LlmCapabilities {
    return { vision: true, structuredOutput: this.nativeSchemaSupported === false ? "prompted" : "native" };
  }

  async extract<T>(tier: ModelTier, req: ExtractRequest<T>): Promise<ExtractResult<T>> {
    const schema = promptSchemaFor(req);
    const model = this.modelFor(tier);
    return extractWithRetry(req, async (repairInstruction): Promise<AttemptOutput> => {
      const messages = buildMessages(
        req.system,
        appendInstructions(req.prompt, repairInstruction, this.nativeSchemaSupported === false ? jsonInstruction(schema) : undefined),
        req.images,
      );

      if (this.nativeSchemaSupported !== false) {
        try {
          const body = await this.chat({
            model,
            messages,
            response_format: {
              type: "json_schema",
              json_schema: { name: req.schemaName.replace(/[^a-zA-Z0-9_-]/g, "_"), schema },
            },
          });
          this.nativeSchemaSupported = true;
          return attemptFromResponse(body, model);
        } catch (err) {
          // servers without response_format support reject the request shape;
          // remember and fall through to the prompted path
          if (err instanceof LlmError && /response_format|json_schema|400/i.test(err.message)) {
            this.nativeSchemaSupported = false;
          } else {
            throw err;
          }
        }
      }

      const promptedMessages = buildMessages(
        req.system,
        appendInstructions(req.prompt, repairInstruction, jsonInstruction(schema)),
        req.images,
      );
      const body = await this.chat({ model, messages: promptedMessages });
      return attemptFromResponse(body, model);
    });
  }

  async *stream(tier: ModelTier, req: StreamRequest): AsyncIterable<StreamEvent> {
    const model = this.modelFor(tier);
    const res = await fetch(this.url("/chat/completions"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model,
        messages: buildMessages(req.system, req.prompt, req.images),
        stream: true,
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    }).catch((err) => {
      throw reachError(this.config.baseUrl, err, CHAT_TIMEOUT_MS);
    });
    if (!res.ok || !res.body) {
      throw new LlmError(`chat/completions stream failed: HTTP ${res.status} ${await safeText(res)}`);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newlineIdx;
      while ((newlineIdx = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIdx).trim();
        buffer = buffer.slice(newlineIdx + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const text = json.choices?.[0]?.delta?.content;
          if (text) yield { type: "text", text };
        } catch {
          // partial line — ignore
        }
      }
    }
    yield { type: "done", model };
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const res = await fetch(this.url("/models"), {
        headers: this.headers(),
        signal: AbortSignal.timeout(META_TIMEOUT_MS),
      });
      if (!res.ok) {
        return {
          ok: false,
          detail: `GET /models → HTTP ${res.status}${res.status === 401 ? " — check the API key" : ""}`,
          latencyMs: Date.now() - started,
        };
      }
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const count = body.data?.length ?? 0;
      return {
        ok: true,
        detail: `reachable, ${count} model${count === 1 ? "" : "s"} listed`,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      return {
        ok: false,
        detail: `cannot reach ${this.config.baseUrl}: ${err instanceof Error ? err.message : String(err)}`,
        latencyMs: Date.now() - started,
      };
    }
  }

  private url(path: string): string {
    return `${this.config.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.config.apiKey) headers.authorization = `Bearer ${this.config.apiKey}`;
    return headers;
  }

  private async chat(payload: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(this.url("/chat/completions"), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    }).catch((err) => {
      throw reachError(this.config.baseUrl, err, CHAT_TIMEOUT_MS);
    });
    if (!res.ok) {
      throw new LlmError(`chat/completions failed: HTTP ${res.status} ${await safeText(res)}`);
    }
    return res.json();
  }
}

function attemptFromResponse(body: unknown, model: string): AttemptOutput {
  const parsedBody = body as {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  const raw = parsedBody.choices?.[0]?.message?.content ?? "";
  if (!raw) throw new LlmError("chat/completions returned an empty message");
  const out: AttemptOutput = { raw, model };
  if (parsedBody.usage) {
    const usage: LlmUsage = {};
    if (parsedBody.usage.prompt_tokens !== undefined) usage.inputTokens = parsedBody.usage.prompt_tokens;
    if (parsedBody.usage.completion_tokens !== undefined)
      usage.outputTokens = parsedBody.usage.completion_tokens;
    out.usage = usage;
  }
  return out;
}

function appendInstructions(prompt: string, ...instructions: Array<string | undefined>): string {
  return [prompt, ...instructions.filter(Boolean)].join("\n\n");
}

function buildMessages(
  system: string | undefined,
  prompt: string,
  images?: LlmImage[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (system) messages.push({ role: "system", content: system });
  if (images && images.length > 0) {
    messages.push({
      role: "user",
      content: [
        ...images.map((img) => ({
          type: "image_url",
          image_url: { url: `data:${img.mediaType};base64,${img.dataBase64}` },
        })),
        { type: "text", text: prompt },
      ],
    });
  } else {
    messages.push({ role: "user", content: prompt });
  }
  return messages;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "";
  }
}
