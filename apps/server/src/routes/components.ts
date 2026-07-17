import type { FastifyInstance } from "fastify";
import { ComponentCategory, CreateComponentInput, UpdateComponentInput } from "@embedded/core";
import { createArchetypesRepo, createComponentsRepo } from "@embedded/db";
import { groundFromBytes } from "../services/deepen.js";

export async function componentRoutes(app: FastifyInstance) {
  const repo = createComponentsRepo(app.db);
  const archetypesRepo = createArchetypesRepo(app.db);

  app.get("/components", async (req, reply) => {
    const { q, category, familyId, mpns, limit, offset } = req.query as {
      q?: string;
      category?: string;
      familyId?: string;
      mpns?: string;
      limit?: string;
      offset?: string;
    };
    let parsedCategory: ComponentCategory | undefined;
    if (category) {
      const parsed = ComponentCategory.safeParse(category);
      if (!parsed.success) {
        return reply.code(400).send({ error: "invalid category", issues: parsed.error.issues });
      }
      parsedCategory = parsed.data;
    }
    const mpnList = mpns ? mpns.split(",").filter((m) => m !== "") : undefined;
    return repo.list({
      q: q || undefined,
      category: parsedCategory,
      familyId: familyId || undefined,
      ...(mpnList && mpnList.length > 0 ? { mpns: mpnList } : {}),
      ...(limit !== undefined ? { limit: Number(limit) } : {}),
      ...(offset !== undefined ? { offset: Number(offset) } : {}),
    });
  });

  app.get("/components/stats", async () => repo.stats());

  app.get("/components/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const component = repo.get(id);
    if (!component) return reply.code(404).send({ error: "component not found" });
    return component;
  });

  app.post("/components", async (req, reply) => {
    const parsed = CreateComponentInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", issues: parsed.error.issues });
    }
    return reply.code(201).send(repo.create(parsed.data));
  });

  app.patch("/components/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateComponentInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", issues: parsed.error.issues });
    }
    const updated = repo.update(id, parsed.data);
    if (!updated) return reply.code(404).send({ error: "component not found" });
    return updated;
  });

  /**
   * Ground a part from a PDF the user supplied by hand.
   *
   * The escape hatch that makes "every part can be grounded" true. Auto-fetch
   * covers the large majority, but some vendors cannot be fetched from at all:
   * Nordic answers 403 to any programmatic request for the nRF52840 datasheet
   * (both the old infocenter URL and its docs.nordicsemi.com replacement), Bosch
   * retired the host behind every BME/BMP link, and Analog Devices blocks
   * downloads outright. No resolver ladder will ever fix those — but the person
   * at the keyboard can download the PDF in their own browser in ten seconds.
   *
   * Deliberately on the COMPONENT, not on /datasheets: the existing upload route
   * creates an unlinked datasheet that then needs the extract → review → commit
   * flow, which is exactly the logistics a designer should never have to touch.
   * This is one step — drop the file, the part grounds — and it reuses the same
   * pipeline, trust rung and supersede rules as an auto-fetch.
   */
  app.post("/components/:id/datasheet", async (req, reply) => {
    const { id } = req.params as { id: string };
    const component = repo.get(id);
    if (!component) return reply.code(404).send({ error: "component not found" });

    const part = await req.file();
    if (!part || part.fieldname !== "file") {
      return reply.code(400).send({ error: 'multipart file field "file" is required' });
    }
    const bytes = await part.toBuffer();
    // Check the bytes, not the filename or the content-type: a "datasheet.pdf"
    // that is really a vendor's "product moved" HTML page would otherwise be
    // stored and read as if it were the part's datasheet.
    if (bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
      return reply.code(400).send({ error: "that file is not a PDF" });
    }

    try {
      const result = await groundFromBytes(app.db, component, bytes);
      return reply.code(result.status === "grounded" ? 200 : 422).send(result);
    } catch (err) {
      return reply
        .code(422)
        .send({ status: "failed", reason: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete("/components/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    repo.remove(id);
    return reply.code(204).send();
  });

  app.get("/archetypes", async () => archetypesRepo.list());

  app.get("/archetypes/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const archetype = archetypesRepo.get(id);
    if (!archetype) return reply.code(404).send({ error: "archetype not found" });
    return archetype;
  });
}
