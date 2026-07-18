import type { Options, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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

// ---------------------------------------------------------------------------
// Claude Code executable resolution.
//
// The SDK never consults PATH: when `pathToClaudeCodeExecutable` is unset it
// require.resolve()s its own optional native-binary package
// (@anthropic-ai/claude-agent-sdk-<platform>-<arch>) and throws
// "Native CLI binary for <plat>-<arch> not found…" when that package is
// absent — which it is in the app's portable distribution. So: prefer the
// SDK's bundled binary when it resolves (dev installs have it, and it is
// version-matched to the SDK), and only fall back to the user's PATH-installed
// Claude Code when it doesn't.
//
// Bundled-first is implemented by PROBING the optional dep (createRequire
// rooted at the SDK's entry, mirroring the SDK's own resolution exactly —
// same package names, same /claude[.exe] subpath, same existsSync check)
// rather than by catching the not-found error at query time: the SDK throws
// lazily inside the query iterator, so catch-and-retry would mean re-driving
// a half-consumed generator at every call site. The probe runs at most once
// per process and never triggers a failed spawn.
//
// NOTE: the where/which + validate fallback deliberately duplicates the small
// claudeExecutablePath() helper in @embedded/tools — packages/llm does not
// depend on packages/tools, and ~40 duplicated lines is cheaper than a new
// cross-package edge just for this.
// ---------------------------------------------------------------------------

const RESOLVE_TIMEOUT_MS = 4_000;

/** Run a command and capture stdout; resolves undefined on any failure. */
function tryRun(file: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(file, args, { timeout: RESOLVE_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
        resolve(err ? undefined : stdout);
      });
    } catch {
      resolve(undefined);
    }
  });
}

/** Does the SDK's own bundled native binary resolve? (Same logic the SDK uses.) */
function bundledCliResolves(): boolean {
  try {
    const req = createRequire(import.meta.url);
    const sdkEntry = req.resolve("@anthropic-ai/claude-agent-sdk");
    const sdkRequire = createRequire(sdkEntry);
    const ext = process.platform === "win32" ? ".exe" : "";
    const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
    const packages = process.platform === "linux" ? [base, `${base}-musl`] : [base];
    for (const pkg of packages) {
      try {
        const resolved = sdkRequire.resolve(`${pkg}/claude${ext}`);
        if (existsSync(resolved)) return true;
      } catch {
        // keep probing the remaining variants
      }
    }
  } catch {
    // SDK itself not resolvable — nothing bundled to prefer
  }
  return false;
}

/**
 * On Windows a PATH hit is often an npm shim (claude / claude.cmd), which
 * Node refuses to spawn without a shell (CVE-2024-27980) — and the SDK spawns
 * the path directly. The npm package ships the real claude.exe at a fixed
 * spot next to the shim; prefer that (or a plain sibling claude.exe), and
 * keep the shim last so validation gets the final word.
 */
function windowsShimCandidates(found: string): string[] {
  if (/\.exe$/i.test(found)) return [found];
  const dir = dirname(found);
  const siblings = [
    join(dir, "node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"),
    join(dir, "claude.exe"),
  ].filter((p) => existsSync(p));
  return [...siblings, found];
}

/** Locate a runnable Claude Code executable on PATH; undefined when absent. */
async function findPathClaude(): Promise<string | undefined> {
  const lookup = process.platform === "win32" ? "where" : "which";
  const stdout = await tryRun(lookup, ["claude"]);
  if (!stdout) return undefined;
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  // `where` lists every match; try real .exe entries before shims.
  const ordered = [...lines].sort((a, b) => Number(/\.exe$/i.test(b)) - Number(/\.exe$/i.test(a)));
  const candidates = process.platform === "win32" ? ordered.flatMap(windowsShimCandidates) : ordered;
  for (const candidate of [...new Set(candidates)]) {
    const version = await tryRun(candidate, ["--version"]);
    if (version !== undefined && /\d+\.\d+\.\d+/.test(version)) return candidate;
  }
  return undefined;
}

let cliPathResolution: Promise<string | undefined> | undefined;

/**
 * Path to hand the SDK as `pathToClaudeCodeExecutable`, or undefined to let
 * the SDK use its bundled binary. Cached — runs at most once per process.
 * Set EMBEDDED_CLAUDE_FORCE_PATH_CLI=1 to skip the bundled binary and force
 * the PATH fallback (used by tests / diagnostics).
 */
function resolveClaudeExecutable(): Promise<string | undefined> {
  cliPathResolution ??= (async () => {
    const forcePath = process.env["EMBEDDED_CLAUDE_FORCE_PATH_CLI"] === "1";
    if (!forcePath && bundledCliResolves()) return undefined;
    return findPathClaude();
  })();
  return cliPathResolution;
}

/** Keep only the last N chars of captured CLI stderr — enough for diagnostics. */
const STDERR_TAIL_CHARS = 2_000;

/**
 * Provider backed by the Claude Agent SDK, which reuses the Claude Code CLI
 * login — usage bills to the user's Claude subscription, no API key needed.
 * Used as a plain completion engine: one turn, no tools, no filesystem
 * settings, so the BYOM providers stay honest drop-in replacements.
 */
export class ClaudeAgentProvider implements LlmProvider {
  readonly kind = "claude-code" as const;

  /**
   * Tail of the child CLI's stderr. The SDK discards stderr unless an
   * options.stderr callback is provided — without this, spawn/auth failures
   * surface as opaque "process exited" errors.
   */
  private stderrTail = "";

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
      const options = await this.baseOptions(this.modelFor(tier), req.system);
      options.outputFormat = { type: "json_schema", schema };

      let raw = "";
      let parsed: unknown;
      let usage: LlmUsage | undefined;
      try {
        for await (const msg of query({ prompt: buildPrompt(prompt, req.images), options })) {
          if (msg.type === "result") {
            if (msg.subtype !== "success") {
              throw new LlmError(
                this.withStderrTail(
                  claudeResultError(msg.subtype, (msg as { errors?: string[] }).errors),
                ),
              );
            }
            raw = msg.result;
            parsed = msg.structured_output;
            usage = {
              inputTokens: msg.usage.input_tokens,
              outputTokens: msg.usage.output_tokens,
            };
          }
        }
      } catch (err) {
        throw this.asLlmError(err);
      }
      const out: AttemptOutput = { raw, model: this.modelFor(tier) };
      if (parsed !== undefined) out.parsed = parsed;
      if (usage) out.usage = usage;
      return out;
    });
  }

  async *stream(tier: ModelTier, req: StreamRequest): AsyncIterable<StreamEvent> {
    const { query } = await loadSdk();
    const options = await this.baseOptions(this.modelFor(tier), req.system);
    options.includePartialMessages = true;

    let usage: LlmUsage | undefined;
    try {
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
            throw new LlmError(
              this.withStderrTail(
                claudeResultError(msg.subtype, (msg as { errors?: string[] }).errors),
              ),
            );
          }
          usage = { inputTokens: msg.usage.input_tokens, outputTokens: msg.usage.output_tokens };
        }
      }
    } catch (err) {
      throw this.asLlmError(err);
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
      const hint = /Native CLI binary .* not found/i.test(message)
        ? " — the AI runtime could not find a Claude executable. Install Claude Code (claude.com/claude-code) and sign in, then retry."
        : /auth|login|credential|401/i.test(message)
          ? " — run `claude login` in a terminal, or install Claude Code first."
          : "";
      return { ok: false, detail: `${message}${hint}`, latencyMs: Date.now() - started };
    }
  }

  private async baseOptions(model: string, system?: string): Promise<Options> {
    const options: Options = {
      model,
      // no tools are allowed, so extra turns only occur when the CLI retries
      // to satisfy outputFormat schema validation — leave it room to do so
      maxTurns: 5,
      allowedTools: [],
      // do not load user/project CLAUDE.md or settings — plain completion engine
      settingSources: [],
      // the SDK discards the child CLI's stderr unless a callback is set;
      // keep a bounded tail so failures carry real diagnostics
      stderr: (data: string) => {
        this.stderrTail = (this.stderrTail + data).slice(-STDERR_TAIL_CHARS);
      },
    };
    // Bundled SDK binary when available; the user's PATH claude otherwise.
    const cliPath = await resolveClaudeExecutable();
    if (cliPath !== undefined) options.pathToClaudeCodeExecutable = cliPath;
    if (system) options.systemPrompt = system;
    return options;
  }

  private withStderrTail(message: string): string {
    const tail = this.stderrTail.trim();
    return tail ? `${message}\n[claude stderr tail] ${tail}` : message;
  }

  /** Normalize any query failure into an LlmError carrying the stderr tail. */
  private asLlmError(err: unknown): LlmError {
    if (err instanceof LlmError) return err; // already carries the tail
    const message = err instanceof Error ? err.message : String(err);
    return new LlmError(this.withStderrTail(message), err);
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
