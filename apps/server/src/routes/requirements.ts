import type { FastifyInstance } from "fastify";
import { CreateRequirementInput, UpdateRequirementInput } from "@embedded/core";
import { createProjectsRepo, createRequirementsRepo } from "@embedded/db";
import { createLlmProvider } from "@embedded/llm";
import { readLlmSettings } from "../services/llm-settings.js";
import { proposeQuantification } from "../services/quantify.js";

export async function requirementRoutes(app: FastifyInstance) {
  const projectsRepo = createProjectsRepo(app.db);
  const requirementsRepo = createRequirementsRepo(app.db);

  const requireProject = (id: string): boolean => projectsRepo.get(id) !== undefined;

  app.get("/projects/:id/requirements", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!requireProject(id)) return reply.code(404).send({ error: "project not found" });
    return requirementsRepo.listByProject(id);
  });

  app.post("/projects/:id/requirements", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!requireProject(id)) return reply.code(404).send({ error: "project not found" });

    const parsed = CreateRequirementInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", issues: parsed.error.issues });
    }
    const requirement = requirementsRepo.create(id, parsed.data);
    return reply.code(201).send(requirement);
  });

  app.patch("/requirements/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateRequirementInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", issues: parsed.error.issues });
    }
    const requirement = requirementsRepo.update(id, parsed.data);
    if (!requirement) return reply.code(404).send({ error: "requirement not found" });
    return requirement;
  });

  app.delete("/requirements/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    requirementsRepo.remove(id);
    return reply.code(204).send();
  });

  /**
   * A PROPOSED machine-checkable bound for a free-text requirement — never
   * written to the requirement here. Same shape as `/wake-proposal`:
   * accepting the suggestion is the client's separate PATCH, and an
   * unconfigured or failing provider is a normal `{ proposal: null }` 200,
   * not an error — the LLM must never sit on the critical path of an honest
   * question.
   */
  app.post("/requirements/:id/quantify", async (req, reply) => {
    const { id } = req.params as { id: string };
    const requirement = requirementsRepo.get(id);
    if (!requirement) return reply.code(404).send({ error: "requirement not found" });

    let provider;
    try {
      const settings = readLlmSettings();
      provider = createLlmProvider(settings, settings.activeProvider);
    } catch {
      // an unconfigured provider is not an error here — it is simply no suggestion
      return { proposal: null };
    }

    const proposal = await proposeQuantification(provider, {
      text: requirement.text,
      kind: requirement.kind,
    });
    return { proposal };
  });
}
