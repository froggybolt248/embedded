import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

// EMBEDDED_DATA_DIR must be set before @embedded/db resolves the sqlite path,
// so this runs before importing the app — same seam as blocks.test.ts.
const dataDir = mkdtempSync(join(tmpdir(), "embedded-grounding-persistence-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");
const { deepenComponent, groundingState } = await import("./services/deepen.js");

interface GroundingRow {
  blockId: string;
  componentId: string | null;
  status: string;
  detail: string | null;
  error: string | null;
}

/**
 * `deepenInBackground` is fire-and-forget, so a route that binds a part
 * doesn't wait for grounding to settle — poll instead of assuming timing.
 * (Same class of quirk as the 127.0.0.1 polling noted for this app's own
 * dev loop: an async attempt against a closed local port resolves fast but
 * not synchronously.)
 */
async function waitForSettled(
  app: FastifyInstance,
  projectId: string,
  componentId: string,
  timeoutMs = 5000,
): Promise<GroundingRow> {
  const start = Date.now();
  for (;;) {
    const res = await app.inject({ method: "GET", url: `/api/projects/${projectId}/grounding` });
    const rows = res.json() as GroundingRow[];
    const row = rows.find((r) => r.componentId === componentId);
    if (row && row.status !== "grounding") return row;
    if (Date.now() - start > timeoutMs) throw new Error("grounding did not settle in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Proves the fix for the bug where `deepen.ts` tracked grounding state in an
 * in-memory Map ONLY: a server restart lost WHY a part failed to ground, and
 * the UI then had nothing useful to show for it. `grounding_states` is now
 * the source of truth; the map is just a hot-path cache.
 */
describe("grounding state survives a restart on the same data dir", () => {
  let app: FastifyInstance;

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  // Rebuilds the whole app twice (fresh migrate + seed each time) around a real
  // fetch attempt — comfortably under 5s alone, but it can brush vitest's default
  // timeout when the whole suite runs in parallel, so give it explicit headroom.
  it("keeps a failed part's status and error message after closing and rebuilding the app", async () => {
    app = buildApp();
    await app.ready();

    // A datasheet URL that fails fast (nothing listens on this port) rather
    // than a real vendor host — deterministic and doesn't need the network.
    const created = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: {
        mpn: "UNREACHABLE-PART",
        category: "other",
        variantAttrs: { datasheet: "http://127.0.0.1:1/nope.pdf" },
      },
    });
    expect(created.statusCode).toBe(201);
    const componentId = (created.json() as { id: string }).id;

    // Ground it directly (awaited) so the first failure is deterministic,
    // rather than relying on the fire-and-forget bind path's timing.
    const result = await deepenComponent(app.db, componentId);
    expect(result.status).toBe("failed");
    expect(result.reason).toBeTruthy();

    const live = groundingState(app.db, componentId);
    expect(live?.status).toBe("failed");
    expect(live?.error).toBeTruthy();
    const errorBeforeRestart = live?.error;

    // Close and rebuild the app on the SAME data dir. The in-memory map is
    // gone — a fresh process has none of it — but the persisted row must
    // still answer with the same status and failure reason.
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();

    app = buildApp();
    await app.ready();

    const afterRestart = groundingState(app.db, componentId);
    expect(afterRestart?.status).toBe("failed");
    expect(afterRestart?.error).toBe(errorBeforeRestart);
    expect(afterRestart?.error).toBeTruthy();

    // And the grounding route — what the UI actually reads — surfaces it too.
    const project = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "restart-grounding-project" },
    });
    const projectId = (project.json() as { id: string }).id;
    const block = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/blocks`,
      payload: { name: "Radio", componentId },
    });
    expect(block.statusCode).toBe(201);

    const row = await waitForSettled(app, projectId, componentId);
    expect(row.status).toBe("failed");
    expect(row.error).toBeTruthy();
  }, 20000);

  it("keeps an unavailable part's status after a restart", async () => {
    // Rebuild fresh so this test doesn't depend on the previous one's app instance.
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    app = buildApp();
    await app.ready();

    // No datasheet URL at all — a bulk-imported skeleton with nothing to ground from.
    const created = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: { mpn: "NO-DATASHEET-PART", category: "other" },
    });
    const componentId = (created.json() as { id: string }).id;

    const result = await deepenComponent(app.db, componentId);
    expect(result.status).toBe("unavailable");

    const before = groundingState(app.db, componentId);
    expect(before?.status).toBe("unavailable");
    expect(before?.detail).toBeTruthy();

    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    app = buildApp();
    await app.ready();

    const after = groundingState(app.db, componentId);
    expect(after?.status).toBe("unavailable");
    expect(after?.detail).toBe(before?.detail);
  }, 20000);
});
