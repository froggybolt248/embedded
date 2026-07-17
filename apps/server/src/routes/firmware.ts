import type { FastifyInstance } from "fastify";
import type { Component } from "@embedded/core";
import {
  createBlocksRepo,
  createComponentsRepo,
  createConnectionsRepo,
  createProjectsRepo,
} from "@embedded/db";
import { generatePinmapHeader, generatePlatformioIni } from "../services/firmware.js";

/**
 * v1 firmware codegen, served fresh on every request.
 *
 * No persistence yet: the `firmwareArtifacts` table exists for a later phase
 * that wants provenance and regeneration history, but generating from the
 * live design on every GET means there is never a stale artifact to confuse
 * with the current one.
 */
export async function firmwareRoutes(app: FastifyInstance) {
  const projectsRepo = createProjectsRepo(app.db);
  const blocksRepo = createBlocksRepo(app.db);
  const connectionsRepo = createConnectionsRepo(app.db);
  const componentsRepo = createComponentsRepo(app.db);

  app.get("/projects/:id/firmware", async (req, reply) => {
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

    const input = { projectName: project.name, blocks, connections, components };

    return {
      files: [
        { name: "pins.h", kind: "pinmap-header", content: generatePinmapHeader(input) },
        { name: "platformio.ini", kind: "platformio-ini", content: generatePlatformioIni(input) },
      ],
    };
  });
}
