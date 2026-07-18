import type { FastifyInstance } from "fastify";
import type { Component } from "@embedded/core";
import {
  createBlocksRepo,
  createComponentsRepo,
  createConnectionsRepo,
  createProjectsRepo,
} from "@embedded/db";
import {
  buildFirmwareProject,
  detectPlatformIO,
  detectRenode,
  ensureRenode,
  startRenodeSession,
} from "@embedded/tools";
import { simulationTargetFor, supportedSimulationBoards } from "../services/simulation-targets.js";
import {
  bootCommands,
  materializeSimProject,
  renodeInstallDir,
} from "../services/simulate.js";

/**
 * The Simulate phase's API: test the design's firmware without owning the
 * hardware.
 *
 * Everything here is honest about capability. The capability endpoint reports
 * exactly which of the three legs (a simulatable MCU, the simulator, the
 * build toolchain) are standing, and the run endpoint refuses with the
 * missing leg named rather than failing somewhere ambiguous fifteen seconds
 * in. The run itself streams what it actually did — build output, the exact
 * Monitor commands, live UART bytes — because a simulation whose transcript
 * can be replayed by hand in Renode is auditable, and a black box is not.
 */
export async function simulateRoutes(app: FastifyInstance) {
  const projectsRepo = createProjectsRepo(app.db);
  const blocksRepo = createBlocksRepo(app.db);
  const connectionsRepo = createConnectionsRepo(app.db);
  const componentsRepo = createComponentsRepo(app.db);

  /** The three legs a simulation stands on, reported without spin. */
  app.get("/projects/:id/simulate/capability", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = projectsRepo.get(id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const blocks = blocksRepo.listByProject(id);
    const mcuBlock = blocks.find((b) => b.role === "mcu" && b.componentId);
    const mcu = mcuBlock?.componentId ? componentsRepo.get(mcuBlock.componentId) : undefined;
    const target = simulationTargetFor(mcu?.mpn);

    const [renode, platformio] = await Promise.all([
      detectRenode(renodeInstallDir()),
      detectPlatformIO(),
    ]);

    return {
      // target: what this design's MCU maps to, or the honest "not supported"
      target: target
        ? { supported: true, boardName: target.boardName, mpn: mcu?.mpn }
        : {
            supported: false,
            ...(mcu?.mpn !== undefined ? { mpn: mcu.mpn } : {}),
            detail: mcu
              ? `simulation does not support ${mcu.mpn} yet`
              : "no MCU part is bound in this design",
          },
      supportedBoards: supportedSimulationBoards(),
      renode,
      platformio,
    };
  });

  /** Download the simulator, streaming progress as ndjson — mirrors /llm/ollama/pull. */
  app.post("/simulate/renode/download", async (_req, reply) => {
    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (obj: unknown) => raw.write(JSON.stringify(obj) + "\n");

    try {
      const exePath = await ensureRenode({
        installDir: renodeInstallDir(),
        onProgress: (p) => send({ event: "progress", ...p }),
      });
      send({ event: "done", exePath });
    } catch (err) {
      send({ event: "error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      raw.end();
    }
  });

  /**
   * Build the generated firmware and boot it on the simulated board,
   * streaming every step. Refuses up front, with the missing leg named,
   * when the run cannot possibly succeed.
   */
  app.post("/projects/:id/simulate/run", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = projectsRepo.get(id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const blocks = blocksRepo.listByProject(id);
    const connections = connectionsRepo.listByProject(id);
    const mcuBlock = blocks.find((b) => b.role === "mcu" && b.componentId);
    const mcu = mcuBlock?.componentId ? componentsRepo.get(mcuBlock.componentId) : undefined;
    const target = simulationTargetFor(mcu?.mpn);
    if (!target) {
      return reply.code(409).send({
        error: mcu
          ? `simulation does not support ${mcu.mpn} yet — supported: ${supportedSimulationBoards().join(", ")}`
          : "no MCU part is bound in this design",
      });
    }
    const [renode, platformio] = await Promise.all([
      detectRenode(renodeInstallDir()),
      detectPlatformIO(),
    ]);
    if (!renode.present || renode.exePath === undefined) {
      return reply.code(409).send({ error: "Renode is not downloaded yet — download it from this page first" });
    }
    if (!platformio.present) {
      return reply.code(409).send({
        error: "PlatformIO is not installed — install it from platformio.org/install/cli, then retry",
      });
    }

    const components = new Map<string, Component>();
    for (const block of blocks) {
      if (!block.componentId || components.has(block.componentId)) continue;
      const component = componentsRepo.get(block.componentId);
      if (component) components.set(block.componentId, component);
    }

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      "content-type": "application/x-ndjson",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const send = (obj: unknown) => raw.write(JSON.stringify(obj) + "\n");
    let clientGone = false;
    raw.on("close", () => {
      clientGone = true;
    });

    try {
      send({ event: "phase", phase: "materialize" });
      const dir = await materializeSimProject({
        projectId: id,
        projectName: project.name,
        blocks,
        connections,
        components,
      });
      send({ event: "materialized", dir });

      send({ event: "phase", phase: "build" });
      const built = await buildFirmwareProject(dir, {
        onProgress: (chunk) => send({ event: "build-output", chunk }),
      });
      send({ event: "built", elfPath: built.elfPath });

      send({ event: "phase", phase: "boot" });
      const session = await startRenodeSession({ exePath: renode.exePath });
      try {
        await session.attachUart(target.renodeUartPath, (chunk) => {
          if (!clientGone) send({ event: "uart", chunk });
        });
        for (const command of bootCommands(target, built.elfPath)) {
          send({ event: "monitor", command });
          const output = await session.exec(command);
          if (output.trim().length > 0) send({ event: "monitor-output", command, output });
        }

        // Sample the LED for a few seconds: a heartbeat that BLINKS proves
        // the core is executing, not merely loaded. 8 samples over ~4 s
        // brackets the smoke firmware's 500 ms toggle comfortably.
        const samples: string[] = [];
        for (let i = 0; i < 8 && !clientGone; i++) {
          await new Promise((r) => setTimeout(r, 500));
          const state = await session.queryState(target.renodeLedPath);
          samples.push(state);
          send({ event: "led", state });
        }
        const blinked = samples.includes("True") && samples.includes("False");
        send({ event: "done", ledBlinked: blinked, ledSamples: samples });
      } finally {
        await session.close();
      }
    } catch (err) {
      send({ event: "error", error: err instanceof Error ? err.message : String(err) });
    } finally {
      raw.end();
    }
  });
}
