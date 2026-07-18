import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  LlmSettings,
  OllamaProvider,
  createLlmProvider,
  recommendOllamaModels,
  type LlmProviderKind,
} from "@embedded/llm";
import { detectHardware, detectOllamaCli, detectClaudeCli } from "@embedded/tools";
import { readLlmSettings, writeLlmSettings } from "../services/llm-settings.js";

const ProviderKind = z.enum(["claude-code", "openai-compat", "ollama"]);

/** tiny end-to-end structured extraction, used by the Settings "Test" button */
const ExtractProbe = z.object({
  part: z.string(),
  voltage_v: z.number(),
  interfaces: z.array(z.string()),
});

export async function llmRoutes(app: FastifyInstance) {
  app.get("/llm/settings", async () => readLlmSettings());

  app.put("/llm/settings", async (req, reply) => {
    const parsed = LlmSettings.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid settings", issues: parsed.error.issues });
    }
    writeLlmSettings(parsed.data);
    return parsed.data;
  });

  /** installed Ollama models + capabilities, so Settings can offer real choices */
  app.get("/llm/ollama/models", async (_req, reply) => {
    const settings = readLlmSettings();
    const provider = new OllamaProvider(settings.ollama);
    try {
      return { models: await provider.listModels() };
    } catch (err) {
      return reply.code(502).send({
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  app.post("/llm/health", async (req, reply) => {
    const body = (req.body ?? {}) as { provider?: string };
    let kind: LlmProviderKind | undefined;
    if (body.provider !== undefined) {
      const parsed = ProviderKind.safeParse(body.provider);
      if (!parsed.success) return reply.code(400).send({ error: "invalid provider" });
      kind = parsed.data;
    }
    const settings = readLlmSettings();
    const provider = createLlmProvider(settings, kind ?? settings.activeProvider);
    const health = await provider.health();
    return { provider: provider.kind, ...health };
  });

  /**
   * One-shot environment scan for the setup wizard: what hardware is here, which
   * runtimes are installed/running, and which local models we'd recommend. Kept
   * fast (bounded probes, no token spend) — the "does Claude actually log in"
   * and "does Ollama actually extract" confirmations happen when the user picks
   * a door, via /llm/health and /llm/extract-test.
   */
  app.get("/llm/detect", async () => {
    const settings = readLlmSettings();
    const ollamaBase = settings.ollama.baseUrl;

    const [hardware, ollamaCli, claudeCli, server] = await Promise.all([
      detectHardware(),
      detectOllamaCli(),
      detectClaudeCli(),
      probeOllamaServer(ollamaBase),
    ]);

    const recommendation = recommendOllamaModels(hardware.budgetGb, hardware.accelerator);
    const installed = new Set(server.installedModels);
    const missingModels = recommendation.uniqueModels.filter((m) => !installed.has(m));

    return {
      hardware,
      ollama: {
        cliInstalled: ollamaCli.present,
        ...(ollamaCli.version !== undefined ? { cliVersion: ollamaCli.version } : {}),
        serverRunning: server.running,
        ...(server.version !== undefined ? { serverVersion: server.version } : {}),
        installedModels: server.installedModels,
      },
      claudeCode: {
        cliInstalled: claudeCli.present,
        ...(claudeCli.version !== undefined ? { cliVersion: claudeCli.version } : {}),
      },
      recommendation: {
        ...recommendation,
        missingModels,
        alreadyInstalled: missingModels.length === 0,
      },
    };
  });

  /**
   * Pull one or more Ollama models, streaming progress as newline-delimited
   * JSON so the wizard can show a live bar. This is the "automatically download
   * a model" path: the browser opens it, watches the bytes, and closes it. Each
   * line is {model,status,completed?,total?,percent?} | {model,done} |
   * {model,error}; a final {done:true} marks the whole batch complete.
   */
  app.post("/llm/ollama/pull", async (req, reply) => {
    const parsed = z
      .object({ models: z.array(z.string().min(1).max(200)).min(1).max(6) })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "expected { models: string[] }" });
    }
    const settings = readLlmSettings();
    const base = settings.ollama.baseUrl.replace(/\/+$/, "");

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (obj: unknown) => raw.write(JSON.stringify(obj) + "\n");

    const abort = new AbortController();
    raw.on("close", () => abort.abort());

    try {
      for (const model of parsed.data.models) {
        try {
          await pullOne(base, model, abort.signal, send);
          send({ model, done: true });
        } catch (err) {
          send({ model, error: err instanceof Error ? err.message : String(err) });
          // stop the batch: later models usually share the same failure (server down)
          break;
        }
      }
      send({ done: true });
    } finally {
      raw.end();
    }
  });

  app.post("/llm/extract-test", async (req, reply) => {
    const body = (req.body ?? {}) as { provider?: string };
    let kind: LlmProviderKind | undefined;
    if (body.provider !== undefined) {
      const parsed = ProviderKind.safeParse(body.provider);
      if (!parsed.success) return reply.code(400).send({ error: "invalid provider" });
      kind = parsed.data;
    }
    const settings = readLlmSettings();
    const provider = createLlmProvider(settings, kind ?? settings.activeProvider);
    try {
      const result = await provider.extract("triage", {
        schema: ExtractProbe,
        schemaName: "extract-probe",
        system:
          "You extract structured facts from component descriptions. Answer only from the given text.",
        prompt:
          'From this text, extract the part name, supply voltage in volts, and the list of digital interfaces: "The BME280 runs from 1.8 V and talks I2C or SPI."',
      });
      return {
        provider: provider.kind,
        ok: true,
        model: result.model,
        retried: result.retried,
        data: result.data,
        usage: result.usage ?? null,
      };
    } catch (err) {
      return reply.code(502).send({
        provider: provider.kind,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

interface OllamaServerProbe {
  running: boolean;
  version?: string;
  installedModels: string[];
}

/** Server reachability + version + installed tags — never throws. */
async function probeOllamaServer(baseUrl: string): Promise<OllamaServerProbe> {
  const base = baseUrl.replace(/\/+$/, "");
  try {
    const vres = await fetch(`${base}/api/version`, { signal: AbortSignal.timeout(3_000) });
    if (!vres.ok) return { running: false, installedModels: [] };
    const version = ((await vres.json()) as { version?: string }).version;
    let installedModels: string[] = [];
    try {
      const tres = await fetch(`${base}/api/tags`, { signal: AbortSignal.timeout(3_000) });
      if (tres.ok) {
        const body = (await tres.json()) as { models?: Array<{ name?: string }> };
        installedModels = (body.models ?? [])
          .map((m) => m.name)
          .filter((n): n is string => !!n);
      }
    } catch {
      /* tags optional — server is up either way */
    }
    return { running: true, installedModels, ...(version !== undefined ? { version } : {}) };
  } catch {
    return { running: false, installedModels: [] };
  }
}

/**
 * Stream one model's pull from Ollama, forwarding normalized progress. Ollama's
 * /api/pull emits many status lines and repeated {completed,total} for each
 * layer; we pass through a percent so the UI needn't know the layering.
 */
async function pullOne(
  base: string,
  model: string,
  signal: AbortSignal,
  send: (obj: unknown) => void,
): Promise<void> {
  const res = await fetch(`${base}/api/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: model, stream: true }),
    signal,
  }).catch((err) => {
    throw new Error(
      `cannot reach Ollama at ${base} — is it running? (${err instanceof Error ? err.message : String(err)})`,
    );
  });
  if (!res.ok || !res.body) {
    throw new Error(`ollama /api/pull failed for "${model}": HTTP ${res.status}`);
  }

  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let json: { status?: string; total?: number; completed?: number; error?: string };
      try {
        json = JSON.parse(line);
      } catch {
        continue;
      }
      if (json.error) throw new Error(json.error);
      const out: Record<string, unknown> = { model, status: json.status ?? "" };
      if (typeof json.total === "number") out["total"] = json.total;
      if (typeof json.completed === "number") out["completed"] = json.completed;
      if (typeof json.total === "number" && json.total > 0) {
        out["percent"] = Math.round(((json.completed ?? 0) / json.total) * 100);
      }
      send(out);
    }
  }
}
