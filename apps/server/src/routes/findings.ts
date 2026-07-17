import type { FastifyInstance } from "fastify";
import type { Component } from "@embedded/core";
import {
  createBlocksRepo,
  createComponentsRepo,
  createConnectionsRepo,
  createProjectsRepo,
  createRulesRepo,
} from "@embedded/db";
import { powerBudget } from "@embedded/calc";
import { RuleRegistry, evaluateRules } from "@embedded/rules";
import { buildRuleTargets, type DesignSnapshot } from "../services/rule-targets.js";
import { createPowerService } from "../services/design-power.js";

/**
 * Everything the design says is wrong, or cannot yet be checked.
 *
 * This is the Electrical phase: the invisible analog rules, run over the actual
 * wiring. Nothing here is new arithmetic — the rules are ordinary DB rows, the
 * evaluator is the sandboxed one, and this route's whole job is to assemble an
 * honest snapshot of the design and hand it over.
 *
 * The critical property is that a finding can be `needs-input` rather than a
 * verdict. Bus capacitance depends on a board that does not exist yet and a
 * receiver's VIH depends on its logic family; neither is derivable, and a
 * plausible default for either would silently decide whether the design passes.
 * A rule whose inputs are missing says so and names them — it never guesses, and
 * it never quietly disappears, because a check that vanishes reads exactly like
 * a check that passed.
 */
export async function findingRoutes(app: FastifyInstance) {
  const projectsRepo = createProjectsRepo(app.db);
  const blocksRepo = createBlocksRepo(app.db);
  const componentsRepo = createComponentsRepo(app.db);
  const connectionsRepo = createConnectionsRepo(app.db);
  const rulesRepo = createRulesRepo(app.db);
  const { powerTargetOf, buildContributors } = createPowerService(app.db);

  // No builtins are registered yet: every shipped rule is expression-based, and
  // `evaluateRule` already reports a `broken` finding for a builtin with no
  // implementation rather than skipping it. The registry exists so a check too
  // gnarly for an expression has somewhere to live without becoming invisible.
  const registry = new RuleRegistry();

  app.get("/projects/:id/findings", async (req, reply) => {
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

    // The budget the battery rule is judged against is the SAME one the budget
    // panel shows, contributors and all — computed here rather than re-derived,
    // so a finding can never contradict the number on screen.
    const target = powerTargetOf(id);
    const batteryCapacityMah = target?.batteryCapacityMah ?? 220;
    const { contributors } = buildContributors(id, {});
    // With nothing grounded the budget divides by a zero draw and reports
    // "forever". That is not a design that meets its target, it is a design we
    // know nothing about — so the battery rule gets no budget and says so.
    const budget =
      contributors.length > 0
        ? powerBudget({ contributors, batteryCapacityMah })
        : undefined;

    const snapshot: DesignSnapshot = {
      projectId: id,
      projectName: project.name,
      blocks,
      connections,
      components,
      ...(budget !== undefined
        ? {
            budget: {
              estimatedLifeYears: budget.batteryLifeYears,
              avgCurrentMa: budget.averageCurrentMa,
              batteryMah: batteryCapacityMah,
            },
          }
        : {}),
      ...(target?.minLifeYears !== undefined ? { targetLifeYears: target.minLifeYears } : {}),
    };

    const targets = buildRuleTargets(snapshot);
    const findings = evaluateRules(rulesRepo.listEnabled(), targets, registry);
    return { findings };
  });
}
