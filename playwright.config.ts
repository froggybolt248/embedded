import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Isolation seam: @embedded/db's appDataDir() (packages/db/src/paths.ts) reads
 * EMBEDDED_DATA_DIR before falling back to %APPDATA%/embedded, and both the
 * sqlite DB path and the settings.json path derive from appDataDir(). Setting
 * this env var on the server's child process BEFORE it boots keeps the whole
 * E2E run off the user's real ~22k-part library and real settings. This is
 * the same seam apps/server/src/app.test.ts already relies on.
 *
 * Created once per `playwright test` invocation (this file is evaluated once),
 * NOT removed afterwards — deleting a live sqlite file out from under a
 * server process that might still be shutting down is asking for an EPERM/
 * data-loss race on Windows. It's a normal OS temp dir; leftover runs are
 * harmless and easy to spot (`embedded-e2e-*`).
 */
const dataDir = mkdtempSync(join(tmpdir(), "embedded-e2e-"));

// NOT 4517: the developer's own `pnpm dev` server is routinely already
// listening there (confirmed live during setup — 127.0.0.1:4517 was bound by
// a pre-existing process). Colliding with it would either fail to bind or,
// worse, run the suite against whatever data dir THAT process has open. A
// dedicated port sidesteps the question entirely rather than trying to
// detect/reuse/kill someone else's server.
const SERVER_PORT = 4617;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: `http://localhost:${SERVER_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: { browserName: "chromium" },
    },
  ],
  // Single origin, not the two-port vite-proxy dev setup: apps/web/vite.config.ts
  // hardcodes its API proxy target to http://localhost:4517 (application
  // source, not something this test suite may edit), which is unusable once
  // the real dev server already owns that port. Fastify's production path
  // (apps/server/src/main.ts) serves the built SPA from apps/web/dist and
  // answers /api itself on ONE port — so `npx vite build` is run once before
  // this config starts the server (see the E2E report for the exact command).
  // This still drives the real UI in a real browser; it just skips the dev-only
  // proxy hop, which is dev tooling, not app behavior under test.
  webServer: {
    command: "npx tsx src/main.ts",
    cwd: "apps/server",
    url: `http://127.0.0.1:${SERVER_PORT}/api/health`,
    env: {
      EMBEDDED_DATA_DIR: dataDir,
      EMBEDDED_PORT: String(SERVER_PORT),
    },
    reuseExistingServer: false,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
