import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { CreateBlockInput, UpdateBlockInput } from "@embedded/core";
import {
  createArchetypesRepo,
  createBlocksRepo,
  createComponentsRepo,
  createProjectsRepo,
} from "@embedded/db";
import {
  DEFAULT_INTERVALS,
  dutyFraction,
  intervalTradeoff,
  powerBudget,
  targetUnreachable,
  type DutyCycle,
} from "@embedded/calc";
import { createLlmProvider } from "@embedded/llm";
import { deepenInBackground, groundingState, isGrounded } from "../services/deepen.js";
import { createPowerService } from "../services/design-power.js";
import { readLlmSettings } from "../services/llm-settings.js";
import { proposeWakeInterval } from "../services/wake-proposal.js";

const Duty = z.object({
  everySec: z.number().positive(),
  forMs: z.number().nonnegative(),
});

const PowerBudgetBody = z.object({
  /**
   * Optional for the same reason the trade-off's is: the archetype states the
   * battery this design is built around. Send only what the user overrode —
   * a client-invented default would be a second copy of that rule, and the two
   * copies would eventually disagree about which cell the answer describes.
   */
  batteryCapacityMah: z.number().positive().optional(),
  /**
   * Per-block, per-mode duty overrides: { blockId: { tx: {everySec, forMs} } }.
   * Anything absent falls back to the role default, so a caller can send `{}`
   * and still get a believable budget.
   */
  duties: z.record(z.record(Duty)).default({}),
});

/**
 * Every field is optional because the DESIGN already states most of them: an
 * archetype carries the battery it is built around and the life it is judged
 * against (`recipe.powerTarget`). Making the caller restate "220 mAh, 1 year" is
 * the logistics this app exists to remove — and a client-invented capacity would
 * silently change the answer to the only question on the page.
 */
const WakeTradeoffBody = z.object({
  batteryCapacityMah: z.number().positive().optional(),
  /** the design's stated goal — absent means no verdict, NOT a failed one */
  targetLifeYears: z.number().positive().optional(),
  /** override the offered ladder; defaults to the human one in @embedded/calc */
  candidates: z.array(z.number().positive()).nonempty().optional(),
  /** unsaved what-if duties, same shape as the budget route */
  duties: z.record(z.record(Duty)).default({}),
});

/** The designer's answer to "how often does this wake?", about to become the design. */
const WakeCadenceBody = z.object({ everySec: z.number().positive() });

/** Last-resort battery when neither the caller nor the archetype names one. */
const ASSUMED_CAPACITY_MAH = 220;

export async function blockRoutes(app: FastifyInstance) {
  const projectsRepo = createProjectsRepo(app.db);
  const blocksRepo = createBlocksRepo(app.db);
  const componentsRepo = createComponentsRepo(app.db);
  const archetypesRepo = createArchetypesRepo(app.db);
  // Shared with the findings route so every calculator judges the SAME design
  // from the same grounded currents.
  const { effectiveSpecs, powerTargetOf, buildContributors } = createPowerService(app.db);

  const requireProject = (id: string): boolean => projectsRepo.get(id) !== undefined;

  app.get("/projects/:id/blocks", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!requireProject(id)) return reply.code(404).send({ error: "project not found" });
    return blocksRepo.listByProject(id);
  });

  app.post("/projects/:id/blocks", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!requireProject(id)) return reply.code(404).send({ error: "project not found" });

    const parsed = CreateBlockInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", issues: parsed.error.issues });
    }
    const block = blocksRepo.create(id, parsed.data);
    // binding at creation time counts as a bind — ground it
    if (block.componentId) deepenInBackground(app.db, block.componentId);
    return reply.code(201).send(block);
  });

  app.patch("/blocks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const parsed = UpdateBlockInput.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", issues: parsed.error.issues });
    }
    const block = blocksRepo.update(id, parsed.data);
    if (!block) return reply.code(404).send({ error: "block not found" });

    // The whole point of the bridge: binding a part to a block is the user's
    // only action, and the grounded data arrives behind it. No ingest button.
    if (parsed.data.componentId) deepenInBackground(app.db, parsed.data.componentId);
    return block;
  });

  app.delete("/blocks/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    blocksRepo.remove(id);
    return reply.code(204).send();
  });

  /** Per-block grounding, so the UI can show a quiet "grounding…" indicator. */
  app.get("/projects/:id/grounding", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!requireProject(id)) return reply.code(404).send({ error: "project not found" });

    return blocksRepo.listByProject(id).map((block) => {
      if (!block.componentId) {
        return { blockId: block.id, componentId: null, status: "unbound" as const };
      }
      const component = componentsRepo.get(block.componentId);
      const live = groundingState(app.db, block.componentId);
      // Grounding is not binary and pretending it is was a bug: a part with
      // ratings but no current table IS grounded for the rail checks and is
      // NOT for the power budget. One green dot next to a budget that says
      // "no current data" is two panels contradicting each other, so the
      // partial state is its own visible status rather than either lie.
      const specs = component ? effectiveSpecs(component) : undefined;
      const status =
        live && live.status !== "grounded"
          ? live.status
          : component && specs && isGrounded({ ...component, specs })
            ? specs.powerStates.length > 0
              ? ("grounded" as const)
              : ("partial" as const)
            : ("ungrounded" as const);
      return {
        blockId: block.id,
        componentId: block.componentId,
        status,
        detail: live?.detail ?? null,
        error: live?.error ?? null,
      };
    });
  });

  /**
   * The cadence this design is actually SAVED at, when its saved duties agree on
   * one — the difference between a choice the designer made and a default nobody
   * ever looked at.
   *
   * Reads `block.duties` directly rather than the resolved contributor duties on
   * purpose: those fall back through the archetype to the role default, so every
   * untouched project would report a cadence and the UI would show a decision
   * that was never taken. Disagreement returns undefined — a design whose blocks
   * wake at different rates has no single cadence, and picking one to highlight
   * would be inventing one.
   */
  function savedCadence(projectId: string): number | undefined {
    const everySecs = new Set<number>();
    for (const block of blocksRepo.listByProject(projectId)) {
      for (const duty of Object.values(block.duties ?? {})) everySecs.add(duty.everySec);
    }
    const [only] = [...everySecs];
    return everySecs.size === 1 ? only : undefined;
  }

  /**
   * Commit a cadence: the answer to the trade-off question becomes the design.
   *
   * Server-side because deciding WHICH states a cadence may re-time is the same
   * rule `intervalTradeoff` prices with — an always-on regulator's quiescent draw
   * is not the wake rate's to move. Re-implementing that test in the view would
   * put a third copy of it in the codebase, and the copies would eventually
   * disagree about what the user was shown versus what got saved.
   *
   * `forMs` is carried across untouched: how long a part must stay awake is a
   * datasheet fact, and the cadence question never asked about it.
   */
  app.post("/projects/:id/wake-cadence", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!requireProject(id)) return reply.code(404).send({ error: "project not found" });

    const parsed = WakeCadenceBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", issues: parsed.error.issues });
    }
    const { everySec } = parsed.data;

    const { contributors } = buildContributors(id, {});
    const saved: string[] = [];
    for (const contributor of contributors) {
      const block = blocksRepo.get(contributor.id);
      if (!block) continue;

      const duties: Record<string, DutyCycle> = { ...block.duties };
      let changed = false;
      for (const state of contributor.states) {
        // always-on states cost what they cost; the cadence does not reach them
        if (dutyFraction(state.duty) >= 1) continue;
        duties[state.mode] = { everySec, forMs: state.duty.forMs };
        changed = true;
      }
      if (changed && blocksRepo.update(contributor.id, { duties })) saved.push(contributor.id);
    }
    return { everySec, blockIds: saved };
  });

  /**
   * The first calculator on the golden path. Reads only grounded currents;
   * blocks whose part has no current data are reported as `ungrounded` rather
   * than silently guessed at — an uncited number is worse than a missing one.
   *
   * A POST because the per-block duty map is structured input, not a filter.
   */
  app.post("/projects/:id/power-budget", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!requireProject(id)) return reply.code(404).send({ error: "project not found" });

    const parsed = PowerBudgetBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", issues: parsed.error.issues });
    }
    const { duties } = parsed.data;
    const { contributors, ungrounded } = buildContributors(id, duties);

    const target = powerTargetOf(id);
    const batteryCapacityMah =
      parsed.data.batteryCapacityMah ?? target?.batteryCapacityMah ?? ASSUMED_CAPACITY_MAH;

    const result = powerBudget({ contributors, batteryCapacityMah });
    return {
      ...result,
      ungrounded,
      // what this estimate is ABOUT: the view renders these, it does not re-derive
      // them, so the budget and the goal can never end up describing two cells
      batteryCapacityMah,
      ...(target?.batteryLabel ? { batteryLabel: target.batteryLabel } : {}),
      ...(target?.minLifeYears !== undefined ? { targetLifeYears: target.minLifeYears } : {}),
    };
  });

  /**
   * What each wake cadence would actually cost — the numbers that make "how
   * often do you need a reading?" a question worth answering.
   *
   * Deliberately free, deterministic and LLM-free. The suggested cadence lives
   * on its own route precisely so that a missing or broken provider can never
   * stand between the designer and an honest answer: the priced options are the
   * product, the suggestion is a convenience.
   */
  app.post("/projects/:id/wake-tradeoff", async (req, reply) => {
    const { id } = req.params as { id: string };
    if (!requireProject(id)) return reply.code(404).send({ error: "project not found" });

    const parsed = WakeTradeoffBody.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid input", issues: parsed.error.issues });
    }
    const { duties, candidates } = parsed.data;
    const { contributors, ungrounded } = buildContributors(id, duties);

    // With nothing grounded there is no draw to divide the battery by, and the
    // arithmetic would answer "runs forever" — a confidently-cited absurdity of
    // exactly the kind this codebase exists to refuse. No parts, no options.
    if (contributors.length === 0) {
      return { options: [], targetUnreachable: false, ungrounded };
    }

    // The design states its own goal: an archetype is built around a specific
    // battery and the life it must reach. The caller can override, but nothing
    // here invents a target — absent everywhere means no verdict is rendered.
    const target = powerTargetOf(id);
    const batteryCapacityMah =
      parsed.data.batteryCapacityMah ?? target?.batteryCapacityMah ?? ASSUMED_CAPACITY_MAH;
    const targetLifeYears = parsed.data.targetLifeYears ?? target?.minLifeYears;

    const savedEverySec = savedCadence(id);
    const options = intervalTradeoff({
      contributors,
      batteryCapacityMah,
      candidates: candidates ?? DEFAULT_INTERVALS,
      ...(targetLifeYears !== undefined ? { targetLifeYears } : {}),
    });
    return {
      options,
      targetUnreachable: targetUnreachable(options),
      ungrounded,
      batteryCapacityMah,
      ...(target?.batteryLabel ? { batteryLabel: target.batteryLabel } : {}),
      ...(targetLifeYears !== undefined ? { targetLifeYears } : {}),
      // absent when the design has no saved cadence — the view must not mark a
      // default as the designer's answer
      ...(savedEverySec !== undefined ? { savedEverySec } : {}),
    };
  });

  /**
   * A starting point for the cadence question, guessed from the project's
   * context by the LLM.
   *
   * Its OWN route, and that separation is the design. The priced options above
   * are free, instant and deterministic; this is a convenience that can be
   * absent, slow, or broken without ever standing between the designer and an
   * honest answer. `{ proposal: null }` — no provider, provider down, model
   * off-ladder — is a normal 200, because "we have no suggestion" is a fine
   * thing to say and the question is answerable without one.
   */
  app.post("/projects/:id/wake-proposal", async (req, reply) => {
    const { id } = req.params as { id: string };
    const project = projectsRepo.get(id);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const archetype = project.archetypeId ? archetypesRepo.get(project.archetypeId) : undefined;
    const blocks = blocksRepo.listByProject(id).map((b) => {
      const component = b.componentId ? componentsRepo.get(b.componentId) : undefined;
      return {
        name: b.name,
        role: b.role,
        ...(component !== undefined ? { mpn: component.mpn } : {}),
      };
    });

    let provider;
    try {
      const settings = readLlmSettings();
      provider = createLlmProvider(settings, settings.activeProvider);
    } catch {
      // an unconfigured provider is not an error here — it is simply no suggestion
      return { proposal: null };
    }

    const proposal = await proposeWakeInterval(provider, {
      projectName: project.name,
      ...(archetype !== undefined ? { archetypeName: archetype.name } : {}),
      blocks,
    });
    return { proposal };
  });
}
