import type { FastifyInstance } from "fastify";
import type { Component } from "@embedded/core";
import {
  createBlocksRepo,
  createComponentsRepo,
  createConnectionsRepo,
  createProjectsRepo,
} from "@embedded/db";
import { buildSchematic } from "../services/schematic.js";

/**
 * v1 pin-level schematic, derived fresh from the live design on every GET —
 * same reasoning as firmware.ts: there is no persisted artifact yet, so
 * there is never a stale one to confuse with the current design.
 */
export async function schematicRoutes(app: FastifyInstance) {
  const projectsRepo = createProjectsRepo(app.db);
  const blocksRepo = createBlocksRepo(app.db);
  const connectionsRepo = createConnectionsRepo(app.db);
  const componentsRepo = createComponentsRepo(app.db);

  app.get("/projects/:id/schematic", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = projectsRepo.get(id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const blocks = blocksRepo.listByProject(id);
    const connections = connectionsRepo.listByProject(id);

    const components = new Map<string, Component>();
    for (const block of blocks) {
      if (!block.componentId || components.has(block.componentId)) continue;
      const component = componentsRepo.get(block.componentId);
      if (component) components.set(block.componentId, component);
    }

    return buildSchematic({
      project: { id: project.id, name: project.name },
      blocks,
      connections,
      components,
    });
  });
}
