import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import {
  LlmError,
  type ExtractRequest,
  type ExtractResult,
  type LlmCapabilities,
  type LlmProvider,
  type ModelTier,
} from "@embedded/llm";
import { proposeQuantification, type QuantifyInput } from "./services/quantify.js";

const dataDir = mkdtempSync(join(tmpdir(), "embedded-quantify-route-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

const input: QuantifyInput = {
  text: "runs a year on a coin cell",
  kind: "power",
};

/** Minimal fake LlmProvider — no network, no real provider. Mirrors wake-proposal.test.ts. */
function makeFakeProvider(
  respond: (req: ExtractRequest<unknown>) => unknown | Promise<unknown>,
): LlmProvider {
  return {
    kind: "claude-code",
    modelFor: () => "fake-model",
    capabilities: (): LlmCapabilities => ({ vision: false, structuredOutput: "prompted" }),
    async extract<T>(_tier: ModelTier, req: ExtractRequest<T>): Promise<ExtractResult<T>> {
      const data = await respond(req as ExtractRequest<unknown>);
      const parsed = req.schema.safeParse(data);
      if (!parsed.success) {
        throw new LlmError(
          `fake provider: schema validation failed: ${parsed.error.issues
            .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
            .join("; ")}`,
        );
      }
      return { data: parsed.data, model: "fake-model", raw: JSON.stringify(data), retried: false };
    },
    async *stream() {
      yield { type: "done" as const, model: "fake-model" };
    },
    async health() {
      return { ok: true, detail: "fake" };
    },
  };
}

describe("proposeQuantification", () => {
  it("round-trips a valid proposal", async () => {
    const provider = makeFakeProvider(() => ({
      param: "batteryLifeYears",
      op: ">=",
      value: 1,
      unit: "years",
    }));

    const result = await proposeQuantification(provider, input);

    expect(result).toEqual({
      param: "batteryLifeYears",
      op: ">=",
      value: 1,
      unit: "years",
    });
  });

  it("returns null when the provider throws", async () => {
    const provider = makeFakeProvider(() => {
      throw new Error("auth failed");
    });

    const result = await proposeQuantification(provider, input);

    expect(result).toBeNull();
  });

  it("returns null when the response fails schema validation (bad param shape)", async () => {
    const provider = makeFakeProvider(() => ({
      param: "not a valid identifier!",
      op: ">=",
      value: 1,
      unit: "years",
    }));

    const result = await proposeQuantification(provider, input);

    expect(result).toBeNull();
  });

  it("returns null for a non-finite value", async () => {
    const provider = makeFakeProvider(() => ({
      param: "batteryLifeYears",
      op: ">=",
      value: Number.POSITIVE_INFINITY,
      unit: "years",
    }));

    const result = await proposeQuantification(provider, input);

    expect(result).toBeNull();
  });

  it("returns null for an empty unit", async () => {
    const provider = makeFakeProvider(() => ({
      param: "batteryLifeYears",
      op: ">=",
      value: 1,
      unit: "",
    }));

    const result = await proposeQuantification(provider, input);

    expect(result).toBeNull();
  });

  it("returns null when there is no provider", async () => {
    const result = await proposeQuantification(undefined, input);

    expect(result).toBeNull();
  });
});

describe("POST /api/requirements/:id/quantify", () => {
  let app: FastifyInstance;
  let requirementId: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "quantify route project" },
    });
    const projectId = (project.json() as { id: string }).id;

    const requirement = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/requirements`,
      payload: { text: "runs a year on a coin cell" },
    });
    requirementId = (requirement.json() as { id: string }).id;
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("404s for an unknown requirement id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/requirements/no-such-requirement/quantify",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns { proposal: null } with 200 when no provider is configured", async () => {
    // Point the active provider at a port nothing listens on, so the
    // provider fails fast and deterministically (ECONNREFUSED) instead of
    // depending on whether a real ollama/openai-compat endpoint happens to
    // be reachable in whatever environment the test runs in.
    const settings = await app.inject({ method: "GET", url: "/api/llm/settings" });
    await app.inject({
      method: "PUT",
      url: "/api/llm/settings",
      payload: {
        ...(settings.json() as Record<string, unknown>),
        activeProvider: "openai-compat",
        openaiCompat: { baseUrl: "http://127.0.0.1:1", apiKey: "" },
      },
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/requirements/${requirementId}/quantify`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ proposal: null });
  });
});
