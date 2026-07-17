import { describe, expect, it } from "vitest";
import { z } from "zod";
import { extractWithRetry, parseJsonLoose } from "./extract-helpers.js";
import { LlmError } from "./types.js";

describe("parseJsonLoose", () => {
  it("parses plain JSON", () => {
    expect(parseJsonLoose('{"a":1}')).toEqual({ a: 1 });
  });

  it("strips markdown fences", () => {
    expect(parseJsonLoose('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("ignores prose around the object", () => {
    expect(parseJsonLoose('Sure! Here is the data:\n{"a":1}\nHope that helps.')).toEqual({
      a: 1,
    });
  });

  it("handles arrays", () => {
    expect(parseJsonLoose("[1,2,3]")).toEqual([1, 2, 3]);
  });

  it("throws LlmError on garbage", () => {
    expect(() => parseJsonLoose("no json here")).toThrow(LlmError);
  });
});

describe("extractWithRetry", () => {
  const schema = z.object({ value: z.number() });
  const req = { schema, schemaName: "test", prompt: "p" };

  it("returns validated data on first attempt", async () => {
    const result = await extractWithRetry(req, async () => ({
      raw: '{"value": 42}',
      model: "m",
    }));
    expect(result.data).toEqual({ value: 42 });
    expect(result.retried).toBe(false);
  });

  it("prefers provider-parsed structured output over raw text", async () => {
    const result = await extractWithRetry(req, async () => ({
      raw: "irrelevant",
      parsed: { value: 7 },
      model: "m",
    }));
    expect(result.data).toEqual({ value: 7 });
  });

  it("retries once with the validation errors, then succeeds", async () => {
    const prompts: Array<string | undefined> = [];
    const result = await extractWithRetry(req, async (repair) => {
      prompts.push(repair);
      return repair
        ? { raw: '{"value": 1}', model: "m" }
        : { raw: '{"value": "not-a-number"}', model: "m" };
    });
    expect(result.data).toEqual({ value: 1 });
    expect(result.retried).toBe(true);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toMatch(/failed schema validation/);
    expect(prompts[1]).toMatch(/value/);
  });

  it("throws after a failed retry", async () => {
    await expect(
      extractWithRetry(req, async () => ({ raw: '{"value": "nope"}', model: "m" })),
    ).rejects.toThrow(/failed validation after retry/);
  });
});
