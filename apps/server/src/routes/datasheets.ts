import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createComponentsRepo, createDatasheetsRepo, createExtractionRunsRepo, datasheetsDir } from "@embedded/db";
import {
  ExtractionFields,
  LoadedPdf,
  PROMPT_VERSION,
  fieldsToSpecs,
  runExtraction,
  type ExtractionMode,
  type IngestProgress,
} from "@embedded/ingest";
import { createLlmProvider } from "@embedded/llm";
import { readLlmSettings } from "../services/llm-settings.js";
import { pageCachePath, renderPageCached } from "../services/page-cache.js";

/** live progress for in-flight extractions; entries removed once a run settles */
const progressMap = new Map<string, IngestProgress>();

const CommitBody = z.object({
  fields: ExtractionFields,
  componentId: z.string().optional(),
});

export async function datasheetRoutes(app: FastifyInstance) {
  const dsRepo = createDatasheetsRepo(app.db);
  const runsRepo = createExtractionRunsRepo(app.db);
  const componentsRepo = createComponentsRepo(app.db);

  app.post("/datasheets", async (req, reply) => {
    const part = await req.file();
    if (!part || part.fieldname !== "file") {
      return reply.code(400).send({ error: 'multipart file field "file" is required' });
    }
    const bytes = await part.toBuffer();
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    // content-addressed dedupe: same bytes → same datasheet row
    const existing = dsRepo.findBySha(sha256);
    if (existing) return existing;

    const filePath = join(datasheetsDir(), `${sha256}.pdf`);
    writeFileSync(filePath, bytes);

    const pdf = await LoadedPdf.open(new Uint8Array(bytes));
    let pageCount: number;
    try {
      pageCount = pdf.pageCount;
    } finally {
      await pdf.close();
    }

    const datasheet = dsRepo.create({ filename: part.filename, filePath, sha256, pageCount });
    return reply.code(201).send(datasheet);
  });

  app.get("/datasheets", async () => dsRepo.list());

  app.get("/datasheets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const datasheet = dsRepo.get(id);
    if (!datasheet) return reply.code(404).send({ error: "datasheet not found" });
    return datasheet;
  });

  app.delete("/datasheets/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    // row only — the content-addressed PDF stays on disk
    dsRepo.remove(id);
    return reply.code(204).send();
  });

  app.get("/datasheets/:id/pages/:n", async (req, reply) => {
    const { id, n } = req.params as { id: string; n: string };
    const datasheet = dsRepo.get(id);
    if (!datasheet) return reply.code(404).send({ error: "datasheet not found" });
    const page = Number(n);
    if (!Number.isInteger(page) || page < 1 || page > datasheet.pageCount) {
      return reply.code(404).send({ error: "page out of range" });
    }

    const cached = pageCachePath(datasheet.sha256, page);
    if (existsSync(cached)) {
      return reply.type("image/png").send(createReadStream(cached));
    }

    const pdf = await LoadedPdf.open(new Uint8Array(readFileSync(datasheet.filePath)));
    try {
      const png = await renderPageCached(pdf, datasheet.sha256, page);
      return reply.type("image/png").send(png);
    } finally {
      await pdf.close();
    }
  });

  /** the background job behind POST /datasheets/:id/extract */
  async function executeExtraction(
    runId: string,
    filePath: string,
    sha256: string,
    mode: ExtractionMode,
  ): Promise<void> {
    const pdf = await LoadedPdf.open(new Uint8Array(readFileSync(filePath)));
    try {
      const provider = createLlmProvider(readLlmSettings());
      const output = await runExtraction({
        pdf,
        provider,
        pageImage: (page) => renderPageCached(pdf, sha256, page),
        onProgress: (p) => progressMap.set(runId, p),
        mode,
      });
      runsRepo.update(runId, {
        status: "draft",
        sectionMap: output.sectionMap,
        fields: output.fields as unknown as Record<string, unknown>,
      });
      progressMap.delete(runId);
    } finally {
      await pdf.close();
    }
  }

  app.post("/datasheets/:id/extract", async (req, reply) => {
    const { id } = req.params as { id: string };
    const datasheet = dsRepo.get(id);
    if (!datasheet) return reply.code(404).send({ error: "datasheet not found" });

    // `deterministic` runs the free Tier 0 + Tier 1 path only — for bulk,
    // zero-cost ingest. `hybrid` (default) adds the vision fallback for the
    // pages the free path could not cover.
    const { mode: modeRaw } = req.query as { mode?: string };
    const mode: ExtractionMode = modeRaw === "deterministic" ? "deterministic" : "hybrid";

    const provider = createLlmProvider(readLlmSettings());
    const run = runsRepo.create({
      datasheetId: datasheet.id,
      model: mode === "deterministic" ? "deterministic" : provider.modelFor("extraction"),
      promptVersion: PROMPT_VERSION,
    });

    // fire and forget — the run row carries the outcome
    void executeExtraction(run.id, datasheet.filePath, datasheet.sha256, mode).catch((err) => {
      progressMap.delete(run.id);
      runsRepo.update(run.id, {
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return reply.code(202).send(run);
  });

  app.get("/datasheets/:id/extraction-runs", async (req, reply) => {
    const { id } = req.params as { id: string };
    const datasheet = dsRepo.get(id);
    if (!datasheet) return reply.code(404).send({ error: "datasheet not found" });
    return runsRepo.listByDatasheet(id);
  });

  app.get("/extraction-runs/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = runsRepo.get(id);
    if (!run) return reply.code(404).send({ error: "extraction run not found" });
    return { ...run, progress: progressMap.get(id) ?? null };
  });

  app.post("/extraction-runs/:id/commit", async (req, reply) => {
    const { id } = req.params as { id: string };
    const run = runsRepo.get(id);
    if (!run) return reply.code(404).send({ error: "extraction run not found" });

    const parsed = CommitBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", issues: parsed.error.issues });
    }
    const { fields, componentId } = parsed.data;
    const specs = fieldsToSpecs(fields, run.datasheetId, { verified: true });

    let component;
    if (componentId !== undefined) {
      component = componentsRepo.update(componentId, { specs });
      if (!component) return reply.code(404).send({ error: "component not found" });
    } else {
      if (!fields.identity) {
        return reply.code(400).send({
          error:
            "fields.identity (with mpn) is required to create a component; pass componentId to update an existing one",
        });
      }
      component = componentsRepo.create({
        mpn: fields.identity.mpn,
        ...(fields.identity.manufacturer !== undefined
          ? { manufacturer: fields.identity.manufacturer }
          : {}),
        ...(fields.identity.description !== undefined
          ? { description: fields.identity.description }
          : {}),
        category: "other",
        specs,
      });
    }

    dsRepo.linkComponent(run.datasheetId, component.id);
    const updatedRun = runsRepo.update(run.id, {
      status: "reviewed",
      fields: fields as unknown as Record<string, unknown>,
    });
    return { component, run: updatedRun };
  });
}
