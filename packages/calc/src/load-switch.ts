/**
 * MOSFET / load-switch sizing: conduction loss, gate-drive adequacy, and the
 * junction-temperature rise that follows from both.
 *
 * The classic failure this exists to catch: a logic-level FET's Rds(on) is
 * only guaranteed AT THE Vgs THE DATASHEET TESTED IT AT. A part quoted as
 * "30 mOhm @ Vgs=10V" driven from a 3.3 V MCU GPIO is not a 30 mOhm switch —
 * it is an unspecified, HIGHER Rds(on), because the datasheet's single-point
 * spec says nothing about 3.3 V. The Rds(on)-vs-Vgs curve is nonlinear and
 * part-specific (not in this calculator's inputs), so this module refuses to
 * guess the real number: it computes conduction loss AT THE QUOTED Rds(on)
 * as a labelled floor and reports gate-drive adequacy as its own field,
 * rather than silently using the quoted value as if 3.3 V drive made it true.
 *
 * Because power and temperature rise are monotonically increasing in
 * Rds(on), an inadequately-driven FET's REAL junction temperature can only be
 * higher than this floor computation says — so if the floor already exceeds
 * the rated max junction temperature, the real part definitely does too, and
 * that verdict can be trusted. But if the floor stays under the limit while
 * the gate drive is inadequate, the real answer is unknown — a higher,
 * unmeasured Rds(on) could still push it over. `thermalVerdict` encodes this
 * three-way outcome explicitly rather than collapsing it into a boolean that
 * would have to lie in one direction or the other.
 */

export interface LoadSwitchInput {
  /** current the switch conducts, amps */
  loadCurrentA: number;
  /** Rds(on) as stated by the datasheet, ohms — valid only at gateTestVgsV */
  rdsOnOhms: number;
  /** the Vgs the datasheet's Rds(on) figure was measured at, volts */
  gateTestVgsV: number;
  /** the Vgs this design actually delivers to the gate, volts */
  gateDriveVgsV: number;
  /** junction-to-ambient thermal resistance, degrees C per watt */
  rThetaJaCPerW: number;
  /** ambient temperature around the part, degrees C */
  ambientTempC: number;
  /** the part's maximum rated junction temperature, degrees C */
  maxJunctionTempC: number;
}

export type ThermalVerdict = "ok" | "exceeds" | "unknown";

export interface LoadSwitchResult {
  /** true only when gateDriveVgsV >= gateTestVgsV, i.e. the design actually
   *  reaches the Vgs the quoted Rds(on) was measured at */
  gateDriveAdequate: boolean;
  /** conduction loss computed at the QUOTED Rds(on): I^2 * Rds(on), watts.
   *  A real prediction only when gateDriveAdequate is true; otherwise a
   *  floor, because the real Rds(on) at this design's lower Vgs is higher
   *  and undocumented by a single-point spec. */
  conductionLossAtQuotedRdsOnW: number;
  /** temperature rise above ambient from that floor loss, degrees C */
  junctionTempRiseAtQuotedRdsOnC: number;
  /** ambient + rise, degrees C */
  junctionTempAtQuotedRdsOnC: number;
  /**
   * "exceeds": the floor computation alone already exceeds maxJunctionTempC —
   *   trustworthy regardless of gate drive, since the real number is worse.
   * "ok": the floor is within budget AND the gate drive is adequate, so the
   *   floor is not just a floor, it is the answer.
   * "unknown": the floor is within budget but the gate drive is inadequate —
   *   the real Rds(on) is higher than quoted, by an amount this calculator
   *   cannot know, and it could still push Tj over the limit.
   */
  thermalVerdict: ThermalVerdict;
}

export function loadSwitch(input: LoadSwitchInput): LoadSwitchResult {
  const gateDriveAdequate = input.gateDriveVgsV >= input.gateTestVgsV;

  const conductionLossAtQuotedRdsOnW = input.loadCurrentA * input.loadCurrentA * input.rdsOnOhms;
  const junctionTempRiseAtQuotedRdsOnC = conductionLossAtQuotedRdsOnW * input.rThetaJaCPerW;
  const junctionTempAtQuotedRdsOnC = input.ambientTempC + junctionTempRiseAtQuotedRdsOnC;

  const floorExceeds = junctionTempAtQuotedRdsOnC > input.maxJunctionTempC;
  const thermalVerdict: ThermalVerdict = floorExceeds
    ? "exceeds"
    : gateDriveAdequate
      ? "ok"
      : "unknown";

  return {
    gateDriveAdequate,
    conductionLossAtQuotedRdsOnW,
    junctionTempRiseAtQuotedRdsOnC,
    junctionTempAtQuotedRdsOnC,
    thermalVerdict,
  };
}
