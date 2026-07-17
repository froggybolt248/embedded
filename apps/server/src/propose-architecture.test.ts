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
import {
  proposeArchitecture,
  type ProposeArchitectureInput,
} from "./services/propose-architecture.js";

const dataDir = mkdtempSync(join(tmpdir(), "embedded-propose-architecture-route-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

const input: ProposeArchitectureInput = {
  requirements: [
    { text: "reports temperature every 10 minutes over BLE", kind: "functional" },
    { text: "runs a year on a coin cell", kind: "power" },
  ],
};

/** Minimal fake LlmProvider — no network, no real provider. Mirrors quantify.test.ts. */
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

describe("proposeArchitecture", () => {
  it("round-trips a valid proposal", async () => {
    const provider = makeFakeProvider(() => ({
      blocks: [
        { name: "MCU", role: "mcu", notes: "runs the firmware" },
        { name: "Temp Sensor", role: "sensor", notes: "reads temperature" },
        { name: "Coin Cell", role: "power" },
      ],
      connections: [
        { from: "Temp Sensor", to: "MCU", interface: "i2c" },
        { from: "Coin Cell", to: "MCU", interface: "power" },
      ],
    }));

    const result = await proposeArchitecture(provider, input);

    expect(result).toEqual({
      blocks: [
        { name: "MCU", role: "mcu", notes: "runs the firmware" },
        { name: "Temp Sensor", role: "sensor", notes: "reads temperature" },
        { name: "Coin Cell", role: "power" },
      ],
      connections: [
        { from: "Temp Sensor", to: "MCU", interface: "i2c" },
        { from: "Coin Cell", to: "MCU", interface: "power" },
      ],
    });
  });

  it("drops a connection referencing a block name that was not proposed, keeping the valid ones", async () => {
    const provider = makeFakeProvider(() => ({
      blocks: [
        { name: "MCU", role: "mcu" },
        { name: "Temp Sensor", role: "sensor" },
      ],
      connections: [
        { from: "Temp Sensor", to: "MCU", interface: "i2c" },
        { from: "Radio", to: "MCU", interface: "spi" }, // "Radio" was never proposed
      ],
    }));

    const result = await proposeArchitecture(provider, input);

    expect(result).toEqual({
      blocks: [
        { name: "MCU", role: "mcu" },
        { name: "Temp Sensor", role: "sensor" },
      ],
      connections: [{ from: "Temp Sensor", to: "MCU", interface: "i2c" }],
    });
  });

  it("drops a self-loop connection", async () => {
    const provider = makeFakeProvider(() => ({
      blocks: [
        { name: "MCU", role: "mcu" },
        { name: "Temp Sensor", role: "sensor" },
      ],
      connections: [
        { from: "Temp Sensor", to: "MCU", interface: "i2c" },
        { from: "MCU", to: "MCU", interface: "power" },
      ],
    }));

    const result = await proposeArchitecture(provider, input);

    expect(result).toEqual({
      blocks: [
        { name: "MCU", role: "mcu" },
        { name: "Temp Sensor", role: "sensor" },
      ],
      connections: [{ from: "Temp Sensor", to: "MCU", interface: "i2c" }],
    });
  });

  it("returns null when the provider throws", async () => {
    const provider = makeFakeProvider(() => {
      throw new Error("auth failed");
    });

    const result = await proposeArchitecture(provider, input);

    expect(result).toBeNull();
  });

  it("returns null when the response fails schema validation (bad role)", async () => {
    const provider = makeFakeProvider(() => ({
      blocks: [{ name: "MCU", role: "not-a-role" }],
      connections: [],
    }));

    const result = await proposeArchitecture(provider, input);

    expect(result).toBeNull();
  });

  it("returns null when there is no provider", async () => {
    const result = await proposeArchitecture(undefined, input);

    expect(result).toBeNull();
  });

  it("returns null when the block list is empty (schema-invalid: min 1)", async () => {
    const provider = makeFakeProvider(() => ({
      blocks: [],
      connections: [],
    }));

    const result = await proposeArchitecture(provider, input);

    expect(result).toBeNull();
  });
});

describe("POST /api/projects/:id/architecture-proposal", () => {
  let app: FastifyInstance;
  let projectId: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();

    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "architecture proposal route project" },
    });
    projectId = (project.json() as { id: string }).id;

    await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/requirements`,
      payload: { text: "reports temperature every 10 minutes over BLE" },
    });
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("404s for an unknown project id", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/projects/no-such-project/architecture-proposal",
    });
    expect(res.statusCode).toBe(404);
  });

  it("returns { proposal: null } with 200 when no provider is configured", async () => {
    // Point the active provider at a port nothing listens on, so the
    // provider fails fast and deterministically (ECONNREFUSED) instead of
    // depending on whether a real ollama/openai-compat endpoint happens to
    // be reachable in whatever environment the test runs in.
    const settings = await app.inject({ method: "GET", url: "/api/llm/settings" });
    const putRes = await app.inject({
      method: "PUT",
      url: "/api/llm/settings",
      payload: {
        ...(settings.json() as Record<string, unknown>),
        activeProvider: "openai-compat",
        openaiCompat: { baseUrl: "http://127.0.0.1:1", apiKey: "" },
      },
    });
    expect(putRes.statusCode).toBe(200);

    // confirm the write actually landed in this test's temp EMBEDDED_DATA_DIR
    const confirmed = await app.inject({ method: "GET", url: "/api/llm/settings" });
    expect((confirmed.json() as { activeProvider: string }).activeProvider).toBe(
      "openai-compat",
    );

    const res = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/architecture-proposal`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ proposal: null });
  });
});
