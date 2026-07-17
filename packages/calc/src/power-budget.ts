import type { DutyCycle, PowerMode, ValueSource } from "@embedded/core";

export type { DutyCycle };

/**
 * Power budget & battery life — the first calculator, and the reason grounded
 * component data matters. Every current it consumes is a datasheet-cited value,
 * so the result is itself grounded: a runtime estimate traceable to the page
 * each number came from.
 *
 * Duty is PER PART and PER MODE, not one system-wide active/sleep split. A
 * single global duty is wrong the moment a design has a radio: an LoRa node
 * might wake for 5 s to read sensors but transmit for only 80 ms of that, and
 * smearing one duty across both makes the TX burst look ~60× heavier than it
 * is. Parts genuinely have independent duty cycles, so the model gives each
 * one its own — and each of its modes its own — which is also how the designer
 * already thinks about the problem.
 *
 * A part is in `sleep` whenever it is in none of its listed active states, so
 * the fractions describe only the awake slices and the remainder is implied.
 */

/** Fraction of wall-clock time a duty occupies, clamped to 0..1. */
export function dutyFraction(duty: DutyCycle): number {
  if (duty.everySec <= 0 || duty.forMs <= 0) return 0;
  return clamp01(duty.forMs / (duty.everySec * 1000));
}

/** One mode a part spends time in, with the grounded current it draws there. */
export interface ContributorState {
  mode: PowerMode;
  /** the datasheet's own row name, for display and citation */
  name: string;
  ma: number;
  duty: DutyCycle;
  source?: ValueSource | undefined;
}

export interface PowerContributor {
  id: string;
  label: string;
  /** draw when in none of the active states, in mA */
  sleepMa: number;
  sleepSource?: ValueSource | undefined;
  states: ContributorState[];
}

export interface PowerBudgetInput {
  contributors: PowerContributor[];
  /** usable battery capacity, in mAh */
  batteryCapacityMah: number;
}

export interface StateContribution extends ContributorState {
  fraction: number;
  /** this state's time-averaged share of the part's draw, in mA */
  averageMa: number;
}

export interface PowerContribution {
  id: string;
  label: string;
  /** time-averaged current for this part across all its modes, in mA */
  averageMa: number;
  /** this part's share of the total average draw, 0..100 */
  sharePct: number;
  sleepMa: number;
  sleepSource?: ValueSource | undefined;
  /** fraction of time the part is in none of its active states */
  sleepFraction: number;
  states: StateContribution[];
  /**
   * True when the listed states claim more than all of the time. The budget
   * still returns a number (the states are normalised) but the design is
   * over-committed and the UI must say so rather than quietly rescale.
   */
  overCommitted: boolean;
}

export interface PowerBudgetResult {
  averageCurrentMa: number;
  batteryLifeHours: number;
  batteryLifeDays: number;
  batteryLifeYears: number;
  contributions: PowerContribution[];
}

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

function contribute(c: PowerContributor): PowerContribution {
  const raw = c.states.map((s) => ({ ...s, fraction: dutyFraction(s.duty) }));
  const claimed = raw.reduce((sum, s) => sum + s.fraction, 0);

  // A part cannot be in its modes more than 100% of the time. Rather than
  // returning a nonsense number, rescale proportionally and flag it — the
  // designer asked for something physically impossible and needs to know.
  const overCommitted = claimed > 1;
  const scale = overCommitted ? 1 / claimed : 1;

  const states: StateContribution[] = raw.map((s) => ({
    ...s,
    fraction: s.fraction * scale,
    averageMa: s.fraction * scale * s.ma,
  }));

  const sleepFraction = Math.max(0, 1 - states.reduce((sum, s) => sum + s.fraction, 0));
  const averageMa =
    states.reduce((sum, s) => sum + s.averageMa, 0) + sleepFraction * c.sleepMa;

  return {
    id: c.id,
    label: c.label,
    averageMa,
    sharePct: 0, // filled in once the total is known
    sleepMa: c.sleepMa,
    ...(c.sleepSource !== undefined ? { sleepSource: c.sleepSource } : {}),
    sleepFraction,
    states,
    overCommitted,
  };
}

export function powerBudget(input: PowerBudgetInput): PowerBudgetResult {
  const contributions = input.contributors.map(contribute);
  const averageCurrentMa = contributions.reduce((sum, c) => sum + c.averageMa, 0);

  for (const c of contributions) {
    c.sharePct = averageCurrentMa > 0 ? (c.averageMa / averageCurrentMa) * 100 : 0;
  }

  // capacity / draw; an all-zero (or empty) budget draws nothing and lasts forever
  const batteryLifeHours =
    averageCurrentMa > 0 ? input.batteryCapacityMah / averageCurrentMa : Infinity;

  return {
    averageCurrentMa,
    batteryLifeHours,
    batteryLifeDays: batteryLifeHours / 24,
    batteryLifeYears: batteryLifeHours / 24 / 365,
    contributions,
  };
}
