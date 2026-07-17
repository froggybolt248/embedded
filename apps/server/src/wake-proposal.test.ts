import { describe, expect, it, vi } from "vitest";
import {
  LlmError,
  type ExtractRequest,
  type ExtractResult,
  type LlmCapabilities,
  type LlmProvider,
  type ModelTier,
} from "@embedded/llm";
import { proposeWakeInterval, type WakeProposalInput } from "./services/wake-proposal.js";

const input: WakeProposalInput = {
  projectName: "Backyard Weather Station",
  archetypeName: "coin-cell sensor node",
  blocks: [
    { name: "Sensor", role: "sensor", mpn: "BME280" },
    { name: "MCU", role: "microcontroller", mpn: "nRF52840" },
  ],
};

/** Minimal fake LlmProvider — no network, no real provider. */
function makeFakeProvider(
  respond: (req: ExtractRequest<unknown>) => unknown | Promise<unknown>,
): LlmProvider {
  return {
    kind: "claude-code",
    modelFor: () => "fake-model",
    capabilities: (): LlmCapabilities => ({ vision: false, structuredOutput: "prompted" }),
    async extract<T>(_tier: ModelTier, req: ExtractRequest<T>): Promise<ExtractResult<T>> {
      const data = await respond(req as ExtractRequest<unknown>);
      // Mirror the real providers' contract (see extractWithRetry in
      // @embedded/llm): extract() only ever resolves with schema-valid data,
      // and throws otherwise. A fake that skipped this would let an invalid
      // proposal slip through untested.
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

describe("proposeWakeInterval", () => {
  it("round-trips a valid proposal", async () => {
    const provider = makeFakeProvider(() => ({
      everySec: 600,
      reason: "A weather station's readings change slowly over the course of a day.",
    }));

    const result = await proposeWakeInterval(provider, input);

    expect(result).toEqual({
      everySec: 600,
      reason: "A weather station's readings change slowly over the course of a day.",
    });
  });

  it("rejects an off-ladder everySec and returns null", async () => {
    const provider = makeFakeProvider(() => ({
      everySec: 47,
      reason: "A weather station's readings change slowly.",
    }));

    const result = await proposeWakeInterval(provider, input);

    expect(result).toBeNull();
  });

  it("returns null when the provider throws", async () => {
    const provider = makeFakeProvider(() => {
      throw new Error("auth failed");
    });

    const result = await proposeWakeInterval(provider, input);

    expect(result).toBeNull();
  });

  it("returns null when the response fails schema validation", async () => {
    const provider = makeFakeProvider(() => ({
      everySec: 600,
      // missing/blank reason fails validation
      reason: "",
    }));

    const result = await proposeWakeInterval(provider, input);

    expect(result).toBeNull();
  });

  it("returns null when there is no provider", async () => {
    const result = await proposeWakeInterval(undefined, input);

    expect(result).toBeNull();
  });

  it("rejects a reason that asserts a battery-life or current figure", async () => {
    const provider = makeFakeProvider(() => ({
      everySec: 3600,
      reason: "This will last 2 years on a coin cell.",
    }));

    const result = await proposeWakeInterval(provider, input);

    expect(result).toBeNull();
  });

  it("passes project/archetype/block context through to the prompt", async () => {
    let seenPrompt = "";
    const provider = makeFakeProvider((req) => {
      seenPrompt = req.prompt;
      return { everySec: 300, reason: "Sensor readings only need to be checked periodically." };
    });

    await proposeWakeInterval(provider, input);

    expect(seenPrompt).toContain("Backyard Weather Station");
    expect(seenPrompt).toContain("coin-cell sensor node");
    expect(seenPrompt).toContain("Sensor");
    expect(seenPrompt).toContain("BME280");
    expect(seenPrompt).toContain("MCU");
    expect(seenPrompt).toContain("nRF52840");
  });

  it("validates everySec is constrained by the schema, not by parsing/coercion", async () => {
    const rawSpy = vi.fn();
    const provider = makeFakeProvider((req) => {
      rawSpy(req.schemaName);
      // a value one step off the ladder — must not be snapped to the nearest rung
      return { everySec: 599, reason: "Almost every ten minutes." };
    });

    const result = await proposeWakeInterval(provider, input);

    expect(result).toBeNull();
    expect(rawSpy).toHaveBeenCalledWith("wake-proposal");
  });
});
