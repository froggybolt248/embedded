import { describe, it, expect } from "vitest";
import { detectOllamaCli, detectClaudeCli } from "./runtimes.js";

/**
 * Mirrors probe-rs.test: point the detector at a binary guaranteed not to
 * exist and assert the honest not-found answer, without depending on what the
 * test host has on PATH. The detectors must NEVER throw.
 */
const MISSING = "definitely-not-a-real-binary-xyzzy";

describe("runtime CLI detection", () => {
  it("reports a missing ollama binary as not present, and does not throw", async () => {
    const r = await detectOllamaCli(MISSING);
    expect(r.present).toBe(false);
  });

  it("reports a missing claude binary as not present, and does not throw", async () => {
    const r = await detectClaudeCli(MISSING);
    expect(r.present).toBe(false);
  });
});
