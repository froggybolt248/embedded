import type { FastifyInstance } from "fastify";
import { CreateProjectInput, type SuggestedBlock } from "@embedded/core";
import { createArchetypesRepo, createBlocksRepo, createProjectsRepo } from "@embedded/db";

/**
 * Lay a project out on the canvas so it reads like a block diagram rather than
 * a pile at the origin: the MCU in the middle, everything else around it. Pure
 * presentation, but an architecture you can't see isn't an architecture.
 */
function layout(index: number, total: number, role: string): { x: number; y: number } {
  if (role === "mcu") return { x: 0, y: 0 };
  const others = Math.max(1, total - 1);
  const angle = (index / others) * Math.PI * 2 - Math.PI / 2;
  return { x: Math.round(Math.cos(angle) * 240), y: Math.round(Math.sin(angle) * 160) };
}

export async function projectRoutes(app: FastifyInstance) {
  const repo = createProjectsRepo(app.db);
  const archetypesRepo = createArchetypesRepo(app.db);
  const blocksRepo = createBlocksRepo(app.db);

  app.get("/projects", async () => repo.list());

  app.get("/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = repo.get(id);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return project;
  });

  app.post("/projects", async (req, reply) => {
    const parsed = CreateProjectInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", issues: parsed.error.issues });
    }

    const project = repo.create(parsed.data);

    // Starting from an archetype means starting with the architecture already
    // sketched. The blocks arrive named, roled, and carrying the hint that
    // explains why they exist — so the first screen is a design to react to,
    // not a blank page and a search box.
    if (project.archetypeId) {
      const archetype = archetypesRepo.get(project.archetypeId);
      const suggested: SuggestedBlock[] = archetype?.recipe.suggestedBlocks ?? [];
      suggested.forEach((block, i) => {
        const { x, y } = layout(i, suggested.length, block.role);
        blocksRepo.create(project.id, {
          name: block.name,
          role: block.role,
          ...(block.hint !== undefined ? { notes: block.hint } : {}),
          x,
          y,
        });
      });
    }

    return reply.code(201).send(project);
  });

  app.delete("/projects/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    repo.remove(id);
    return reply.code(204).send();
  });
}
