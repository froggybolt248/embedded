import { describe, it, expect } from "vitest";
import { recommendOllamaModels, OLLAMA_MODEL_SIZES_GB } from "./recommend.js";

describe("recommendOllamaModels", () => {
  it("recommends the standard vision set on a capable GPU", () => {
    const r = recommendOllamaModels(8, "cuda");
    expect(r.tier).toBe("standard");
    expect(r.models.extraction).toBe("qwen2.5vl:7b");
    // extraction (the vision model) is pulled first
    expect(r.uniqueModels[0]).toBe("qwen2.5vl:7b");
    expect(r.note).toContain("8 GB");
  });

  it("steps down to the compact set when VRAM is tight", () => {
    const r = recommendOllamaModels(6, "cuda");
    expect(r.tier).toBe("compact");
    expect(r.models.extraction).toBe("qwen2.5vl:3b");
    expect(r.models.triage).toBe("qwen3:1.7b");
  });

  it("always uses the compact set on CPU and says it will be slow", () => {
    const r = recommendOllamaModels(64, "cpu");
    expect(r.tier).toBe("compact");
    expect(r.note.toLowerCase()).toContain("cpu");
  });

  it("uses metal on Apple silicon", () => {
    const r = recommendOllamaModels(12, "metal");
    expect(r.tier).toBe("standard");
    expect(r.note.toLowerCase()).toContain("apple");
  });

  it("dedupes tiers that share a tag and sizes the download from the table", () => {
    const r = recommendOllamaModels(8, "cuda");
    // triage and assistant are both qwen3:4b — pulled once
    expect(r.uniqueModels).toEqual(["qwen2.5vl:7b", "qwen3:4b"]);
    const expected =
      Math.round(
        (OLLAMA_MODEL_SIZES_GB["qwen2.5vl:7b"]! + OLLAMA_MODEL_SIZES_GB["qwen3:4b"]!) * 10,
      ) / 10;
    expect(r.downloadGb).toBe(expected);
  });
});
