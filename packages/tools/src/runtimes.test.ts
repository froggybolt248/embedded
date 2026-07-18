import { describe, it, expect } from "vitest";
import { detectOllamaCli, detectClaudeCli, claudeExecutablePath } from "./runtimes.js";

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

  it("resolves a missing claude executable to undefined, and does not throw", async () => {
    const p = await claudeExecutablePath(MISSING);
    expect(p).toBeUndefined();
  });

  // Conditional: only meaningful on hosts that actually have Claude Code
  // installed (CI machines vary). When present, the resolved path must be a
  // validated executable, never a bare shim that fails to run.
  it("resolves an installed claude to a runnable path (when present on host)", async () => {
    const installed = await detectClaudeCli();
    if (!installed.present) return; // honest skip on hosts without claude
    const p = await claudeExecutablePath();
    expect(p).toBeDefined();
    const check = await detectClaudeCli(p);
    expect(check.present).toBe(true);
    expect(check.version).toBeDefined();
  });
});
