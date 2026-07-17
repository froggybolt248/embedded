import type { BlockRole, PowerMode } from "@embedded/core";
import type { DutyCycle } from "./power-budget.js";

/**
 * Starting duty cycles by block role and mode.
 *
 * These are ASSUMPTIONS, not facts, and the UI must present them as such —
 * they carry no citation because no datasheet knows how often *your* design
 * wakes up. Their job is to make a new project produce a believable number
 * immediately instead of demanding a form be filled in first; the designer
 * then corrects the ones that matter. Chosen to read like a typical
 * battery-powered build: wake about once a minute, transmit briefly.
 *
 * `power` is the exception that proves the model: a regulator's quiescent
 * current flows continuously, so its duty is 100% and it must never be
 * duty-scaled down like a sensor.
 */
const DEFAULTS: Record<BlockRole, Partial<Record<PowerMode, DutyCycle>>> = {
  mcu: { active: { everySec: 60, forMs: 1000 } },
  sensor: { active: { everySec: 60, forMs: 500 } },
  radio: {
    // TX is the short burst inside a longer awake window — the case a single
    // system-wide duty gets badly wrong
    tx: { everySec: 60, forMs: 100 },
    rx: { everySec: 60, forMs: 1000 },
  },
  display: { refresh: { everySec: 3600, forMs: 3000 } },
  actuator: { active: { everySec: 3600, forMs: 1000 } },
  power: { active: { everySec: 1, forMs: 1000 } },
  other: { active: { everySec: 60, forMs: 1000 } },
};

const FALLBACK: DutyCycle = { everySec: 60, forMs: 1000 };

/** Default duty for one mode of a part in a given role. */
export function defaultDuty(role: BlockRole, mode: PowerMode): DutyCycle {
  return DEFAULTS[role]?.[mode] ?? FALLBACK;
}
