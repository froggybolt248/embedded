import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  LlmSettings,
  OllamaProvider,
  createLlmProvider,
  type LlmProviderKind,
} from "@embedded/llm";
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
