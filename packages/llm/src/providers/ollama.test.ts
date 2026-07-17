import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OllamaProvider } from "./ollama.js";
import { LlmError, type LlmImage } from "../types.js";
import type { LlmSettings } from "../settings.js";

type FetchCall = { path: string; body: Record<string, unknown> | undefined };

interface MockOpts {
  /** models considered "installed": model name -> its /api/show capabilities. Absent => 404. */
  capsByModel?: Record<string, string[]>;
  /** /api/version response; omit to simulate the version endpoint failing */
  version?: string;
}

function jsonResponse(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function createFetchMock(opts: MockOpts) {
  const calls: FetchCall[] = [];
  const fn = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ path, body });

    if (path === "/api/show") {
      const model = body?.model as string | undefined;
      const caps = model ? opts.capsByModel?.[model] : undefined;
      if (!caps) return jsonResponse(404, { error: "model not found" });
      return jsonResponse(200, { capabilities: caps });
    }
    if (path === "/api/chat") {
      return jsonResponse(200, { message: { content: '{"ok":true}' } });
    }
    if (path === "/api/version") {
      if (opts.version === undefined) return jsonResponse(500, {});
      return jsonResponse(200, { version: opts.version });
    }
    throw new Error(`unexpected fetch to ${path}`);
  });
  return { fn, calls };
}

function makeProvider(config?: Partial<LlmSettings["ollama"]>): OllamaProvider {
  return new OllamaProvider({
    baseUrl: "http://127.0.0.1:11434",
    numCtx: 16384,
    requestTimeoutSec: 900,
    models: { triage: "llama3.2", extraction: "qwen2.5vl", assistant: "llama3.3" },
    ...config,
  });
}

const okSchema = z.object({ ok: z.boolean() });

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("OllamaProvider capabilities lookup", () => {
  it("caches /api/show per model across calls", async () => {
    const { fn, calls } = createFetchMock({ capsByModel: { "qwen2.5vl": ["vision"] } });
    vi.stubGlobal("fetch", fn);
    const provider = makeProvider();

    await provider.preflight("extraction", { vision: true });
    await provider.preflight("extraction", { vision: true });

    const showCalls = calls.filter((c) => c.path === "/api/show");
    expect(showCalls).toHaveLength(1);
  });

  it("throws an LlmError with an actionable `ollama pull` hint when the model is not installed (HTTP 404)", async () => {
    const { fn } = createFetchMock({ capsByModel: {} });
    vi.stubGlobal("fetch", fn);
    const provider = makeProvider();

    await expect(provider.preflight("extraction", { vision: true })).rejects.toThrow(LlmError);
    await expect(provider.preflight("extraction", { vision: true })).rejects.toThrow(/ollama pull/);
  });
});

describe("OllamaProvider.extract", () => {
  it("includes think: false in the /api/chat body for thinking models", async () => {
    const { fn, calls } = createFetchMock({
      capsByModel: { "qwen2.5vl": ["completion", "vision", "thinking"] },
    });
    vi.stubGlobal("fetch", fn);
    const provider = makeProvider();

    await provider.extract("extraction", {
      schema: okSchema,
      schemaName: "ok",
      prompt: "say ok",
    });

    const chatCall = calls.find((c) => c.path === "/api/chat");
    expect(chatCall?.body?.think).toBe(false);
  });

  it("omits the `think` key entirely for non-thinking models", async () => {
    const { fn, calls } = createFetchMock({
      capsByModel: { "qwen2.5vl": ["completion", "vision"] },
    });
    vi.stubGlobal("fetch", fn);
    const provider = makeProvider();

    await provider.extract("extraction", {
      schema: okSchema,
      schemaName: "ok",
      prompt: "say ok",
    });

    const chatCall = calls.find((c) => c.path === "/api/chat");
    expect(chatCall?.body).toBeDefined();
    expect("think" in (chatCall?.body ?? {})).toBe(false);
  });

  it("throws an LlmError mentioning vision when images are supplied but the model lacks vision, without calling /api/chat", async () => {
    const { fn, calls } = createFetchMock({
      capsByModel: { "qwen2.5vl": ["completion"] },
    });
    vi.stubGlobal("fetch", fn);
    const provider = makeProvider();

    const image: LlmImage = { mediaType: "image/png", dataBase64: "AAAA" };

    await expect(
      provider.extract("extraction", {
        schema: okSchema,
        schemaName: "ok",
        prompt: "describe this",
        images: [image],
      }),
    ).rejects.toThrow(/vision/i);

    expect(calls.some((c) => c.path === "/api/chat")).toBe(false);
  });
});

describe("OllamaProvider.preflight", () => {
  it("throws for a model without vision when vision is required", async () => {
    const { fn } = createFetchMock({ capsByModel: { "qwen2.5vl": ["completion"] } });
    vi.stubGlobal("fetch", fn);
    const provider = makeProvider();

    await expect(provider.preflight("extraction", { vision: true })).rejects.toThrow(/vision/i);
  });

  it("resolves for a model with vision", async () => {
    const { fn } = createFetchMock({ capsByModel: { "qwen2.5vl": ["completion", "vision"] } });
    vi.stubGlobal("fetch", fn);
    const provider = makeProvider();

    await expect(provider.preflight("extraction", { vision: true })).resolves.toBeUndefined();
  });

  it("only ever calls /api/show, never /api/chat", async () => {
    const { fn, calls } = createFetchMock({ capsByModel: { "qwen2.5vl": ["completion", "vision"] } });
    vi.stubGlobal("fetch", fn);
    const provider = makeProvider();

    await provider.preflight("extraction", { vision: true });

    expect(calls.every((c) => c.path === "/api/show")).toBe(true);
    expect(calls.some((c) => c.path === "/api/chat")).toBe(false);
  });
});

describe("OllamaProvider.health", () => {
  it("reports ok: false with an actionable detail when a tier's model isn't installed", async () => {
    const { fn } = createFetchMock({
      version: "0.5.1",
      capsByModel: {
        // triage model missing entirely -> 404 from /api/show
        qwen2ml: [],
      },
    });
    vi.stubGlobal("fetch", fn);
    const provider = makeProvider();

    const result = await provider.health();

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/ollama pull/);
  });

  it("reports ok: true when /api/version responds and all tier models (with vision for extraction) are installed", async () => {
    const { fn } = createFetchMock({
      version: "0.5.1",
      capsByModel: {
        "llama3.2": ["completion"],
        "qwen2.5vl": ["completion", "vision"],
        "llama3.3": ["completion"],
      },
    });
    vi.stubGlobal("fetch", fn);
    const provider = makeProvider();

    const result = await provider.health();

    expect(result.ok).toBe(true);
    expect(result.detail).toMatch(/0\.5\.1/);
  });
});
