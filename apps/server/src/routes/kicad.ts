import { existsSync, statSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { importKicadDirectory, type KicadImportSummary } from "../services/kicad-import.js";
import { ensureKicadClone } from "../services/kicad-source.js";

const ImportBody = z.object({
  /** import only libraries whose name contains one of these (case-insensitive) */
  libraries: z.array(z.string().min(1)).optional(),
  /** cap the number of components created — a quick sample import */
  limit: z.number().int().positive().optional(),
  /** import from this directory instead of the app-managed clone (skips git) */
  directory: z.string().min(1).optional(),
});

interface KicadJob {
  status: "cloning" | "importing" | "done" | "failed";
  detail: string;
  done: number;
  total: number;
  summary: KicadImportSummary | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

/** One import runs at a time; the whole app is a single-user local process. */
let job: KicadJob | null = null;
const isRunning = (j: KicadJob | null): boolean => j?.status === "cloning" || j?.status === "importing";

/**
 * Channel 1 bulk import as a background job. The app manages a shallow clone of
 * the KiCad symbol library and seeds the component library from it — thousands
 * of parts with pins, datasheet URLs and families — while streaming progress,
 * because the full import writes tens of thousands of rows and must not block a
 * single request. Point it at an existing `directory` to skip the git step.
 */
export async function kicadRoutes(app: FastifyInstance) {
  app.post("/kicad/import", async (req, reply) => {
    const parsed = ImportBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", issues: parsed.error.issues });
    }
    if (isRunning(job)) {
      return reply.code(409).send({ error: "an import is already running", job });
    }
    const { libraries, limit, directory } = parsed.data;

    if (directory !== undefined && (!existsSync(directory) || !statSync(directory).isDirectory())) {
      return reply.code(400).send({ error: `not a directory: ${directory}` });
    }

    job = {
      status: "cloning",
      detail: "starting…",
      done: 0,
      total: 0,
      summary: null,
      error: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
    };

    // fire and forget — the client polls GET /kicad/import/status
    void runImport(app, { ...(libraries ? { libraries } : {}), ...(limit ? { limit } : {}), ...(directory ? { directory } : {}) });

    return reply.code(202).send(job);
  });

  app.get("/kicad/import/status", async () => job ?? { status: "idle" });
}

async function runImport(
  app: FastifyInstance,
  opts: { libraries?: string[]; limit?: number; directory?: string },
): Promise<void> {
  const current = job!;
  try {
    let directory = opts.directory;
    if (directory === undefined) {
      current.status = "cloning";
      directory = await ensureKicadClone((line) => {
        current.detail = line;
      });
    }

    current.status = "importing";
    current.detail = "reading libraries…";
    const summary = await importKicadDirectory(app.db, directory, {
      ...(opts.libraries ? { libraries: opts.libraries } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
      onProgress: (p) => {
        current.detail = p.detail;
        current.done = p.done;
        current.total = p.total;
      },
    });

    current.status = "done";
    current.detail = `imported ${summary.created} components`;
    current.summary = summary;
    current.finishedAt = new Date().toISOString();
  } catch (err) {
    app.log.error(err, "kicad import failed");
    current.status = "failed";
    current.error = err instanceof Error ? err.message : String(err);
    current.finishedAt = new Date().toISOString();
  }
}
