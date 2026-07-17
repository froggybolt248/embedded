/**
 * Pulsed-load droop and bulk-capacitor sizing.
 *
 * This is the failure every archetype in the plan shares, wearing different
 * clothes: a LoRa TX burst, an e-ink refresh, a servo stall, a pyro channel
 * firing, a coin cell asked for 20 mA. The average current is fine, the battery
 * has plenty of capacity left, and the rail still collapses far enough to reset
 * the MCU — because a source with internal resistance cannot deliver a step
 * without sagging, and a brownout is measured in milliseconds, not milliamp-hours.
 *
 * It is invisible in a power budget by construction. A budget averages; this is
 * about the instant. Both numbers are needed and they answer different questions.
 *
 *   sag  = I_pulse * R_source          — the rail's steady droop under the pulse
 *   C    = I_pulse * t_pulse / ΔV      — charge the cap must hold to cover it
 *
 * The capacitor equation is the charge relation Q = C·V rearranged, and it is
 * deliberately the simple form: it ignores the source's contribution during the
 * pulse, so it slightly OVERSIZES the capacitor. That is the right direction to
 * be wrong in — an over-sized bulk cap costs a few cents and a little board area,
 * an under-sized one is a field failure that reproduces only on a cold battery.
 */

export interface PulsedLoadInput {
  /** rail voltage with no load, volts */
  supplyV: number;
  /** the source's internal/output resistance, ohms — a CR2032 is ~10 Ω when
   *  fresh and rises to hundreds as it depletes and in the cold */
  sourceResistanceOhms: number;
  /** current drawn during the burst, amps */
  pulseCurrentA: number;
  /** how long the burst lasts, seconds */
  pulseDurationS: number;
  /** the rail must never fall below this, volts — normally the MCU's brownout
   *  threshold, or the lowest supply voltage every part on the rail accepts */
  minAcceptableV: number;
}

export interface PulsedLoadResult {
  /** how far the rail sags under the pulse with no bulk capacitor, volts */
  sagV: number;
  /** the resulting rail voltage with no bulk capacitor, volts */
  saggedRailV: number;
  /** true when the unaided rail already stays above the floor */
  adequateWithoutCap: boolean;
  /** headroom between the floor and the no-load rail, volts */
  droopBudgetV: number;
  /** smallest bulk capacitance that keeps the rail above the floor, farads;
   *  null when there is no droop budget to work with (see `hopeless`) */
  requiredCapacitanceF: number | null;
  /**
   * Roughly how long that capacitor needs to recharge through the source before
   * the next pulse, seconds (5·R·C — five time constants to ~99%). Null when no
   * capacitor is required.
   *
   * Sizing a cap for one burst and firing again before it has refilled is the
   * subtle version of this bug: the first transmit succeeds and the tenth browns
   * out. Whether the design's duty actually allows this long is the caller's to
   * check — it is the one number here that depends on how often, not how much.
   */
  rechargeTimeS: number | null;
  /**
   * True when the floor is already at or above the no-load rail, so there is no
   * droop budget for a capacitor to spend. Nothing downstream can fix this: the
   * answer is a higher supply or a part that tolerates a lower one.
   */
  hopeless: boolean;
}

export function pulsedLoad(input: PulsedLoadInput): PulsedLoadResult {
  const sagV = input.pulseCurrentA * input.sourceResistanceOhms;
  const saggedRailV = input.supplyV - sagV;
  const droopBudgetV = input.supplyV - input.minAcceptableV;

  if (droopBudgetV <= 0) {
    // the rail is already at or below the floor before any load is applied
    return {
      sagV,
      saggedRailV,
      adequateWithoutCap: false,
      droopBudgetV,
      requiredCapacitanceF: null,
      rechargeTimeS: null,
      hopeless: true,
    };
  }

  if (saggedRailV >= input.minAcceptableV) {
    return {
      sagV,
      saggedRailV,
      adequateWithoutCap: true,
      droopBudgetV,
      requiredCapacitanceF: 0,
      rechargeTimeS: null,
      hopeless: false,
    };
  }

  const requiredCapacitanceF = (input.pulseCurrentA * input.pulseDurationS) / droopBudgetV;
  return {
    sagV,
    saggedRailV,
    adequateWithoutCap: false,
    droopBudgetV,
    requiredCapacitanceF,
    rechargeTimeS: 5 * input.sourceResistanceOhms * requiredCapacitanceF,
    hopeless: false,
  };
}
