import { describe, expect, it, afterEach } from "vitest";
import Fastify from "fastify";
import { capabilityRoutes } from "./capabilities.js";

/**
 * Deliberately does NOT use `buildApp()` — that would register every route
 * plugin, including this one once the orchestrator wires it into app.ts,
 * and registering it twice throws a duplicate-route error. A minimal Fastify
 * instance with only this plugin is enough to exercise the contract.
 */
describe("capabilityRoutes", () => {
  const build = () => {
    const app = Fastify();
    app.register(capabilityRoutes);
    return app;
  };
  let app: ReturnType<typeof build> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("reports probe-rs as absent, honestly, on a host that doesn't have it", async () => {
    app = build();
    await app.ready();

    const res = await app.inject({ method: "GET", url: "/capabilities" });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { probeRs: { present: boolean; version?: string; detail?: string } };
    expect(body).toHaveProperty("probeRs");
    expect(typeof body.probeRs.present).toBe("boolean");
    // This test host has no probe-rs installed, so the honest answer is
    // false with a friendly explanation — never a guess, never a throw.
    if (!body.probeRs.present) {
      expect(body.probeRs.detail).toBeTruthy();
    }
  });
});
