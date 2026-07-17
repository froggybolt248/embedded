import type { FastifyInstance } from "fastify";
import { detectProbeRs } from "@embedded/tools";

/**
 * What optional external tools this machine actually has.
 *
 * This is the whole capability-gating seam for Bring-up: probe-rs is never
 * required, and the client is expected to gate its flash affordance on
 * `probeRs.present` rather than assume the tool exists. Detection is honest —
 * `present: false` is the normal answer on a machine that never installed
 * probe-rs, not an error.
 */
export async function capabilityRoutes(app: FastifyInstance) {
  app.get("/capabilities", async () => {
    const probeRs = await detectProbeRs();
    return { probeRs };
  });
}
