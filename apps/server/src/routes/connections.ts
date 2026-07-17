import type { FastifyInstance } from "fastify";
import { CreateConnectionInput, UpdateConnectionInput } from "@embedded/core";
import { createBlocksRepo, createConnectionsRepo, createProjectsRepo } from "@embedded/db";

/**
 * How the blocks are wired together — the fact the whole Electrical phase is
 * blocked on.
 *
 * A power budget only needs to know which parts exist; the checks that catch the
 * mistakes people actually make (an I²C bus with no pull-ups, a 3.3 V part
 * driving a 1.8 V input) are all statements about a WIRE. Without connections
 * those rules have no subject to run against, so they cannot even be asked.
 */
export async function connectionRoutes(app: FastifyInstance) {
  const projectsRepo = createProjectsRepo(app.db);
  const blocksRepo = createBlocksRepo(app.db);
  const connectionsRepo = createConnectionsRepo(app.db);

  app.get("/projects/:id/connections", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!projectsRepo.get(id)) return reply.code(404).send({ error: "project not found" });
    return connectionsRepo.listByProject(id);
  });

  /**
   * Both endpoints must be blocks of THIS project.
   *
   * The database only enforces that the blocks exist somewhere — a connection
   * naming a block from another project would satisfy the foreign key and then
   * quietly poison every check downstream, which would go looking for that
   * block's part among this design's blocks and find nothing. Cross-project
   * wiring is never what anyone meant, so it is a bad request, not a silent row.
   */
  function endpointError(projectId: string, fromBlockId: string, toBlockId: string): string | null {
    const owned = new Set(blocksRepo.listByProject(projectId).map((b) => b.id));
    if (!owned.has(fromBlockId)) return "the from-block is not a block of this project";
    if (!owned.has(toBlockId)) return "the to-block is not a block of this project";
    // A block wired to itself is a slip of the mouse, not a design. Accepting it
    // would hand the level-shift check a driver and a receiver that are the same
    // part and let it report a confident verdict on nothing.
    if (fromBlockId === toBlockId) return "a block cannot be connected to itself";
    return null;
  }

  app.post("/projects/:id/connections", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!projectsRepo.get(id)) return reply.code(404).send({ error: "project not found" });

    const parsed = CreateConnectionInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", issues: parsed.error.issues });
    }
    const problem = endpointError(id, parsed.data.fromBlockId, parsed.data.toBlockId);
    if (problem) return reply.code(400).send({ error: problem });

    return reply.code(201).send(connectionsRepo.create(id, parsed.data));
  });

  app.patch("/connections/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const existing = connectionsRepo.get(id);
    if (!existing) return reply.code(404).send({ error: "connection not found" });

    const parsed = UpdateConnectionInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", issues: parsed.error.issues });
    }
    // re-checked against the endpoints as they WOULD be, so a patch cannot walk
    // a connection out of its project one end at a time
    const problem = endpointError(
      existing.projectId,
      parsed.data.fromBlockId ?? existing.fromBlockId,
      parsed.data.toBlockId ?? existing.toBlockId,
    );
    if (problem) return reply.code(400).send({ error: problem });

    return connectionsRepo.update(id, parsed.data);
  });

  app.delete("/connections/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    connectionsRepo.remove(id);
    return reply.code(204).send();
  });
}
