import { resolveSpecs, type Component } from "@embedded/core";
import {
  createArchetypesRepo,
  createBlocksRepo,
  createComponentsRepo,
  createProjectsRepo,
  type Db,
} from "@embedded/db";
import {
  defaultDuty,
  modeCurrentsFromSpecs,
  sleepCurrentFromSpecs,
  type ContributorState,
  type DutyCycle,
  type PowerContributor,
} from "@embedded/calc";
import { groundingState } from "./deepen.js";

/**
 * The project's design, read as power contributors.
 *
 * Extracted from the blocks routes because a THIRD caller now needs it: the
 * power budget, the wake trade-off, and the findings all have to judge the same
 * design from the same grounded currents. A calculator that ran over a different
 * set of parts than the budget would silently answer a different question, and
 * the disagreement would surface as two panels quietly contradicting each other.
 */

/** A block that could not enter the budget, and the honest reason why. */
export interface Ungrounded {
  blockId: string;
  name: string;
  reason: string;
}

export type DutyOverrides = Record<string, Record<string, DutyCycle>>;

export function createPowerService(db: Db) {
  const projectsRepo = createProjectsRepo(db);
  const blocksRepo = createBlocksRepo(db);
  const componentsRepo = createComponentsRepo(db);
  const archetypesRepo = createArchetypesRepo(db);

  /** effective specs for a bound part: family rows with the variant's on top */
  function effectiveSpecs(component: Component) {
    const family = component.familyId ? componentsRepo.get(component.familyId) : undefined;
    return resolveSpecs(component, family ?? null);
  }

  /**
   * Why a bound part contributes nothing. The live grounding state is the best
   * answer while the process is up, but it is in-memory: after a restart a part
   * that failed on a dead vendor link looks identical to one nobody ever tried.
   * Falling back to "no current data in this part's datasheet" would then claim
   * we read a datasheet we never fetched, so distinguish the cases honestly.
   */
  function ungroundedReason(component: Component): string {
    const live = groundingState(component.id);
    if (live?.status === "grounding") return "reading its datasheet now";
    if (live?.error) return live.error;

    // Read a datasheet, but not the table this calculator needs. Common on RF
    // parts, whose current tables are laid out unlike a sensor's.
    const specs = effectiveSpecs(component);
    if (specs.absoluteMax.length > 0 || specs.recommendedOperating.length > 0) {
      return "its datasheet was read, but no current-consumption table was found";
    }

    const url =
      component.variantAttrs["datasheet"] ??
      (component.familyId
        ? componentsRepo.get(component.familyId)?.variantAttrs["datasheet"]
        : undefined);
    if (url === undefined || url === "" || url === "~") {
      return "no datasheet link on this part — add its currents by hand";
    }
    return "its datasheet hasn't been read yet — re-bind the part to retry";
  }

  /** The quantified goal this project is judged against, if its archetype states one. */
  function powerTargetOf(projectId: string) {
    const project = projectsRepo.get(projectId);
    const archetype = project?.archetypeId ? archetypesRepo.get(project.archetypeId) : undefined;
    return archetype?.recipe.powerTarget;
  }

  /**
   * The project's blocks as power contributors, plus an honest account of the
   * ones that could not be included and why.
   */
  function buildContributors(
    projectId: string,
    duties: DutyOverrides,
  ): { contributors: PowerContributor[]; ungrounded: Ungrounded[] } {
    // An archetype states duty far better than a role default can: it knows a
    // LoRa node transmits for 80 ms and listens for 2 s, where "radio" alone
    // only knows it is a radio. Joined by block name, same as the UI.
    const project = projectsRepo.get(projectId)!;
    const archetype = project.archetypeId ? archetypesRepo.get(project.archetypeId) : undefined;
    const recipeDuty = new Map(
      (archetype?.recipe.suggestedBlocks ?? []).map((b) => [b.name, b.duty]),
    );

    const contributors: PowerContributor[] = [];
    const ungrounded: Ungrounded[] = [];

    for (const block of blocksRepo.listByProject(projectId)) {
      if (!block.componentId) {
        ungrounded.push({ blockId: block.id, name: block.name, reason: "no part bound" });
        continue;
      }
      const component = componentsRepo.get(block.componentId);
      if (!component) {
        ungrounded.push({ blockId: block.id, name: block.name, reason: "bound part missing" });
        continue;
      }

      const specs = effectiveSpecs(component);
      const modes = modeCurrentsFromSpecs(specs);
      const sleep = sleepCurrentFromSpecs(specs);
      if (modes.length === 0 && sleep === null) {
        ungrounded.push({
          blockId: block.id,
          name: block.name,
          reason: ungroundedReason(component),
        });
        continue;
      }

      // precedence: this request's what-if > what the designer saved on the
      // block > what the archetype knows > the role's default
      const preview = duties[block.id] ?? {};
      const saved = block.duties ?? {};
      const fromRecipe = recipeDuty.get(block.name);
      const states: ContributorState[] = modes.map((m) => ({
        mode: m.mode,
        name: m.name,
        ma: m.ma,
        duty:
          preview[m.mode] ??
          saved[m.mode] ??
          fromRecipe?.[m.mode] ??
          defaultDuty(block.role, m.mode),
        source: m.source,
      }));

      contributors.push({
        id: block.id,
        label: `${block.name} — ${component.mpn}`,
        sleepMa: sleep?.ma ?? 0,
        ...(sleep?.source !== undefined ? { sleepSource: sleep.source } : {}),
        states,
      });
    }

    return { contributors, ungrounded };
  }

  return { effectiveSpecs, ungroundedReason, powerTargetOf, buildContributors };
}
