import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
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
import type { LlmSettings } from "../settings.js";

// The SDK is imported lazily on first use: its module initialization is
// extremely slow under tsx watch (dev server), while a post-boot dynamic
// import is fast. Types above are erased, so boot never touches the SDK.
let sdkModule: Promise<typeof import("@anthropic-ai/claude-agent-sdk")> | undefined;
function loadSdk() {
  sdkModule ??= import("@anthropic-ai/claude-agent-sdk");
  return sdkModule;
}

/**
 * Provider backed by the Claude Agent SDK, which reuses the Claude Code CLI
 * login — usage bills to the user's Claude subscription, no API key needed.
 * Used as a plain completion engine: one turn, no tools, no filesystem
 * settings, so the BYOM providers stay honest drop-in replacements.
 */
export class ClaudeAgentProvider implements LlmProvider {
  readonly kind = "claude-code" as const;

  constructor(private readonly config: LlmSettings["claudeCode"]) {}

  modelFor(tier: ModelTier): string {
    return this.config.models[tier];
  }

  capabilities(): LlmCapabilities {
    return { vision: true, structuredOutput: "native" };
  }

  async extract<T>(tier: ModelTier, req: ExtractRequest<T>): Promise<ExtractResult<T>> {
    const schema = promptSchemaFor(req);
    return extractWithRetry(req, async (repairInstruction): Promise<AttemptOutput> => {
      const { query } = await loadSdk();
      const prompt = repairInstruction ? `${req.prompt}\n\n${repairInstruction}` : req.prompt;
      const options = this.baseOptions(this.modelFor(tier), req.system);
      options.outputFormat = { type: "json_schema", schema };

      let raw = "";
      let parsed: unknown;
      let usage: LlmUsage | undefined;
      for await (const msg of query({ prompt: buildPrompt(prompt, req.images), options })) {
        if (msg.type === "result") {
          if (msg.subtype !== "success") {
            throw new LlmError(claudeResultError(msg.subtype, (msg as { errors?: string[] }).errors));
          }
          raw = msg.result;
          parsed = msg.structured_output;
          usage = {
            inputTokens: msg.usage.input_tokens,
            outputTokens: msg.usage.output_tokens,
          };
        }
      }
      const out: AttemptOutput = { raw, model: this.modelFor(tier) };
      if (parsed !== undefined) out.parsed = parsed;
      if (usage) out.usage = usage;
      return out;
    });
  }

  async *stream(tier: ModelTier, req: StreamRequest): AsyncIterable<StreamEvent> {
    const { query } = await loadSdk();
    const options = this.baseOptions(this.modelFor(tier), req.system);
    options.includePartialMessages = true;

    let usage: LlmUsage | undefined;
    for await (const msg of query({ prompt: buildPrompt(req.prompt, req.images), options })) {
      if (msg.type === "stream_event") {
        const event = msg.event;
        if (
          event.type === "content_block_delta" &&
          event.delta.type === "text_delta" &&
          event.delta.text
        ) {
          yield { type: "text", text: event.delta.text };
        }
      } else if (msg.type === "result") {
        if (msg.subtype !== "success") {
          throw new LlmError(claudeResultError(msg.subtype, (msg as { errors?: string[] }).errors));
        }
        usage = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
      }
    }
    const done: StreamEvent = { type: "done", model: this.modelFor(tier) };
    if (usage) done.usage = usage;
    yield done;
  }

  async health(): Promise<ProviderHealth> {
    const started = Date.now();
    try {
      const result = await this.extract("triage", {
        schema: z.object({ ok: z.boolean() }),
        schemaName: "health-check",
        prompt: 'Return exactly {"ok": true}.',
      });
      return {
        ok: result.data.ok,
        detail: `Claude Code OAuth OK (${result.model})`,
        latencyMs: Date.now() - started,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const hint = /auth|login|credential|401/i.test(message)
        ? " — run `claude login` in a terminal, or install Claude Code first."
        : "";
      return { ok: false, detail: `${message}${hint}`, latencyMs: Date.now() - started };
    }
  }

  private baseOptions(model: string, system?: string): Options {
    const options: Options = {
      model,
      // no tools are allowed, so extra turns only occur when the CLI retries
      // to satisfy outputFormat schema validation — leave it room to do so
      maxTurns: 5,
      allowedTools: [],
      // do not load user/project CLAUDE.md or settings — plain completion engine
      settingSources: [],
    };
    if (system) options.systemPrompt = system;
    return options;
  }
}

function claudeResultError(subtype: string, errors?: string[]): string {
  const detail = errors && errors.length > 0 ? `: ${errors.join("; ")}` : "";
  return `Claude Agent SDK query failed (${subtype})${detail}`;
}

function buildPrompt(
  text: string,
  images?: LlmImage[],
): string | AsyncIterable<SDKUserMessage> {
  if (!images || images.length === 0) return text;
  const content = [
    ...images.map((img) => ({
      type: "image" as const,
      source: {
        type: "base64" as const,
        media_type: img.mediaType,
        data: img.dataBase64,
      },
    })),
    { type: "text" as const, text },
  ];
  async function* gen(): AsyncIterable<SDKUserMessage> {
    yield {
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
    };
  }
  return gen();
}
