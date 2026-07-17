/**
 * I²C pull-up sizing — the archetypal "invisible analog rule".
 *
 * Nothing in a block diagram says an I²C bus needs pull-ups, no compiler
 * complains, and the common failure is not a dead bus but a marginal one: the
 * default 4.7 kΩ everyone copies is fine at 100 kHz and out of spec at 400 kHz
 * with any real trace capacitance, so the bus works on the bench and fails in
 * the field. It is exactly the class of thing this app exists to surface.
 *
 * Both bounds come from NXP UM10204 (the I²C specification):
 *
 *   Rmin = (VDD - VOL) / IOL      — the pin must be able to pull LOW
 *   Rmax = tr / (0.8473 * Cb)     — RC rise must fit the mode's rise-time budget
 *
 * The 0.8473 is not a fudge factor: it is ln(0.9/0.3) — the RC time constants
 * taken to climb the 30%→70% band the spec measures tr across.
 */

/** Bus speed modes and their spec limits (UM10204 Table 10). */
export type I2cMode = "standard" | "fast" | "fast-plus";

interface ModeLimits {
  hz: number;
  /** maximum permitted rise time, seconds */
  riseTimeS: number;
  /** the sink current the low-level output voltage is specified at, amps */
  iolA: number;
}

const MODE_LIMITS: Record<I2cMode, ModeLimits> = {
  standard: { hz: 100_000, riseTimeS: 1000e-9, iolA: 0.003 },
  fast: { hz: 400_000, riseTimeS: 300e-9, iolA: 0.003 },
  // Fast-mode Plus raises IOL to 20 mA precisely so a much stronger pull-up is
  // legal — without that, the 120 ns rise budget would be unreachable.
  "fast-plus": { hz: 1_000_000, riseTimeS: 120e-9, iolA: 0.020 },
};

export function i2cModeForSpeed(hz: number): I2cMode {
  if (hz > 400_000) return "fast-plus";
  if (hz > 100_000) return "fast";
  return "standard";
}

export interface I2cPullupInput {
  vddV: number;
  /** total bus capacitance (traces + every device's pin), farads */
  busCapacitanceF: number;
  mode: I2cMode;
  /** low-level output voltage the driver guarantees, volts (UM10204: 0.4 V) */
  volV?: number;
}

export interface I2cPullupResult {
  minOhms: number;
  maxOhms: number;
  /** a sane pick inside the window: the geometric mean, biased to neither edge */
  recommendedOhms: number;
  /** true when no resistor can satisfy both bounds */
  impossible: boolean;
  /** current the pull-up sinks when the bus is held low, amps */
  sinkCurrentA: number;
  mode: I2cMode;
}

/**
 * The window of legal pull-up resistances, or `impossible` when there is none.
 *
 * `impossible` is a real, common outcome and must be reported rather than
 * papered over by clamping: at 400 kHz a bus over ~400 pF has no legal resistor,
 * and the honest answer is "shorten the bus, add a buffer, or slow down" — not a
 * number that looks like an answer. Returning a clamped value here would be this
 * app's characteristic bug: a confidently cited wrong number.
 */
export function i2cPullup(input: I2cPullupInput): I2cPullupResult {
  const limits = MODE_LIMITS[input.mode];
  const vol = input.volV ?? 0.4;

  const minOhms = (input.vddV - vol) / limits.iolA;
  const maxOhms = limits.riseTimeS / (0.8473 * input.busCapacitanceF);
  const impossible = minOhms > maxOhms;
  const recommendedOhms = impossible ? minOhms : Math.sqrt(minOhms * maxOhms);

  return {
    minOhms,
    maxOhms,
    recommendedOhms,
    impossible,
    sinkCurrentA: input.vddV / recommendedOhms,
    mode: input.mode,
  };
}
