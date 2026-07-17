import { describe, expect, it } from "vitest";
import { detectProbeRs } from "./probe-rs.js";

describe("detectProbeRs", () => {
  it("reports present:false with a friendly detail when the binary does not exist", async () => {
    // A command name guaranteed not to exist on any host, so this exercises
    // the not-found path deterministically instead of depending on whether
    // the test machine happens to have probe-rs installed.
    const result = await detectProbeRs("embedded-definitely-not-a-real-binary");
    expect(result.present).toBe(false);
    expect(result.version).toBeUndefined();
    expect(result.detail).toMatch(/probe-rs not found on PATH/);
  });

  it("never throws, even when the command cannot be spawned", async () => {
    await expect(detectProbeRs("embedded-definitely-not-a-real-binary")).resolves.toBeDefined();
  });

  it("reports present:true with a parsed version when the command succeeds", async () => {
    // Node itself stands in for a well-behaved CLI: `node --version` exits 0
    // and prints a version-shaped string, which is exactly the shape probe-rs
    // is expected to produce.
    const result = await detectProbeRs("node");
    expect(result.present).toBe(true);
    expect(result.version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
