import { powerBudget, dutyFraction, type PowerContributor } from "./power-budget.js";

/**
 * What a different wake interval would cost you — the numbers behind the question
 * "how often do you actually need a reading?".
 *
 * This exists because of a distinction the rest of the app depends on:
 *
 *   `forMs`   — how long a part is awake per cycle. Usually a DATASHEET FACT
 *               (startup time, conversion time). Groundable, citable.
 *   `everySec`— how often YOUR design wakes. Not a fact about any part. No
 *               datasheet knows it, no amount of research reveals it, and a model
 *               "estimating" it is guessing the designer's intent, not reading
 *               anything.
 *
 * So the honest way to fill in `everySec` is to ask — and the way to make that
 * question worth answering is to price each option against the real budget. Every
 * number here comes from re-running `powerBudget()` over the same grounded,
 * datasheet-cited currents; only the interval changes. The consequence is
 * computed, not asserted, which is what separates this from a tooltip that says
 * "polling less often saves power" and leaves the designer to guess how much.
 *
 * This is the "maximum interaction planning, not logistics" surface: the user
 * answers a question about their PRODUCT ("I need a reading every 10 minutes")
 * and the electrical consequence falls out.
 */

/** A state is driven by the wake cadence unless it is simply always on. */
function isPeriodic(fraction: number): boolean {
  // A regulator's quiescent draw is continuous — it costs what it costs to be
  // switched on at all, and rescaling it by a wake interval would be nonsense.
  // The existing model already expresses that as a duty of 100%.
  return fraction < 1;
}

/** Re-time every periodic state onto a new interval, leaving `forMs` alone. */
function atInterval(contributors: PowerContributor[], everySec: number): PowerContributor[] {
  return contributors.map((c) => ({
    ...c,
    states: c.states.map((s) =>
      isPeriodic(dutyFraction(s.duty)) ? { ...s, duty: { ...s.duty, everySec } } : s,
    ),
  }));
}

export interface IntervalOption {
  everySec: number;
  /** how a person would say it: "every 10 minutes" */
  label: string;
  averageCurrentMa: number;
  batteryLifeYears: number;
  /** null when the design states no target to judge against */
  meetsTarget: boolean | null;
}

export interface IntervalTradeoffInput {
  contributors: PowerContributor[];
  batteryCapacityMah: number;
  /** candidate wake intervals, in seconds */
  candidates: number[];
  /** the design's stated goal, when it has one */
  targetLifeYears?: number | undefined;
}

/** "every 10 minutes" — the interval as a designer would say it aloud. */
export function intervalLabel(everySec: number): string {
  const plural = (n: number, unit: string) => `every ${n} ${unit}${n === 1 ? "" : "s"}`;
  if (everySec < 60) return plural(round(everySec), "second");
  if (everySec < 3600) return plural(round(everySec / 60), "minute");
  if (everySec < 86_400) return plural(round(everySec / 3600), "hour");
  return plural(round(everySec / 86_400), "day");
}

const round = (n: number): number => Number(n.toFixed(2));

/**
 * Price each candidate interval against the real budget.
 *
 * Returned in the order given, so the caller controls how the choice is
 * presented. `meetsTarget` is null rather than false when there is no target:
 * "we do not know whether this is good enough" is not the same as "this is not
 * good enough", and collapsing the two would invent a verdict.
 */
export function intervalTradeoff(input: IntervalTradeoffInput): IntervalOption[] {
  return input.candidates.map((everySec) => {
    const result = powerBudget({
      contributors: atInterval(input.contributors, everySec),
      batteryCapacityMah: input.batteryCapacityMah,
    });
    return {
      everySec,
      label: intervalLabel(everySec),
      averageCurrentMa: result.averageCurrentMa,
      batteryLifeYears: result.batteryLifeYears,
      meetsTarget:
        input.targetLifeYears === undefined
          ? null
          : result.batteryLifeYears >= input.targetLifeYears,
    };
  });
}

/**
 * A ladder of intervals worth offering, spanning seconds to a day.
 *
 * Fixed and human-shaped on purpose: these are the cadences people actually
 * design to, and a designer picking "every 10 minutes" is choosing a product
 * behaviour, not tuning a number. Deriving a ladder from the battery instead
 * would quietly let the electronics decide the product.
 */
export const DEFAULT_INTERVALS: number[] = [10, 60, 300, 600, 1800, 3600, 21_600, 86_400];

/**
 * The slowest offered interval that still misses the target, if any — i.e. the
 * point where the design stops being feasible however patient the user is.
 *
 * Worth surfacing because it reframes the question: if even one reading a day
 * misses the target, the interval is not the problem and no answer to "how often"
 * will save it. The part choice or the battery is the problem, and asking the
 * user to keep compromising would be wasting their time.
 */
export function targetUnreachable(options: IntervalOption[]): boolean {
  return options.length > 0 && options.every((o) => o.meetsTarget === false);
}
