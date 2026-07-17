/**
 * LoRa time-on-air and EU868 duty-cycle budget.
 *
 * Formula: Semtech AN1200.13 "LoRa Modem Designer's Guide", section 4
 * ("LoRa Packet Time on Air"). Verified against a second, independently
 * test-vectored implementation of the same equations —
 * avbentem/airtime-calculator, src/lora/Airtime.ts, which cites the same
 * AN1200.13 source and ships unit tests reproducing Semtech's own worked
 * numbers: https://github.com/avbentem/airtime-calculator
 *
 *   Tsym          = 2^SF / BW                                    (seconds)
 *   Tpreamble     = (n_preamble + 4.25) * Tsym
 *   payloadSymbNb = 8 + max(ceil((8*PL - 4*SF + 28 + 16*CRC - 20*H)
 *                                 / (4*(SF - 2*DE))) * (CR + 4), 0)
 *   Tpayload      = payloadSymbNb * Tsym
 *   TimeOnAir     = Tpreamble + Tpayload
 *
 * where H = 0 when the explicit header is sent, 1 when it is not; DE = 1
 * when low-data-rate optimization is enabled (mandatory once a SYMBOL exceeds
 * 16 ms, to counter oscillator drift across a single symbol — see
 * `lowDataRateOptimize`); CR is the coding-rate numerator's complement,
 * 1..4 for 4/5..4/8.
 *
 * Cross-checked worked examples, computed by hand from the formula above and
 * matching avbentem/airtime-calculator's test suite exactly:
 *
 *   SF7, BW=125000 Hz, PL=14 B, CR=4/5, explicit header, CRC on, DE=0,
 *   n_preamble=8:
 *     Tsym = 2^7/125000 = 1.024 ms
 *     Tpreamble = 12.25 * 1.024 = 12.544 ms
 *     numerator = 8*14 - 4*7 + 28 + 16 - 0 = 128; 128/(4*7) = 4.571 -> ceil 5
 *     payloadSymbNb = 8 + 5*5 = 33; Tpayload = 33 * 1.024 = 33.792 ms
 *     TimeOnAir = 46.336 ms  <-- matches the repo's test vector exactly
 *
 *   SF12, BW=125000 Hz, PL=25 B, CR=4/5, explicit header, CRC on, DE=1
 *   (mandatory at SF12/125 kHz), n_preamble=8:
 *     Tsym = 2^12/125000 = 32.768 ms
 *     Tpreamble = 12.25 * 32.768 = 401.408 ms
 *     numerator = 8*25 - 4*12 + 28 + 16 - 0 = 196; 196/(4*10) = 4.9 -> ceil 5
 *     payloadSymbNb = 8 + 5*5 = 33; Tpayload = 33 * 32.768 = 1081.344 ms
 *     TimeOnAir = 1482.752 ms ~= 1.48 s, matching the widely-quoted "~1.5 s
 *     for a small SF12 payload" figure. (Note CR+4 = 5 for the default 4/5
 *     coding rate -- it is easy to misremember this as 8, which silently
 *     produces a payload count nearly double the correct one.)
 */

/** Symbol time above which Semtech mandates low-data-rate optimization. */
const LDRO_SYMBOL_TIME_S = 0.016;

export interface LoraAirtimeInput {
  /** spreading factor, 6..12 (6 is reserved and not used by LoRaWAN) */
  spreadingFactor: number;
  /** signal bandwidth, hertz (typically 125000, 250000, or 500000) */
  bandwidthHz: number;
  /** full over-the-air packet size in bytes — for LoRaWAN this already
   *  includes the MAC header and the 4-byte MIC, not just the application
   *  payload */
  packetSizeBytes: number;
  /** coding-rate denominator: 5, 6, 7, or 8 for 4/5..4/8. LoRaWAN convention:
   *  always 4/5 (5). Defaults to 5 when omitted. */
  codingRateDenominator?: 5 | 6 | 7 | 8 | undefined;
  /** number of preamble symbols. LoRaWAN convention: 8. Defaults to 8. */
  preambleSymbols?: number | undefined;
  /** whether the low-level LoRa header is transmitted. LoRaWAN convention:
   *  always true (the payload length is not fixed, so the header is
   *  required). Defaults to true. */
  explicitHeader?: boolean | undefined;
  /** whether a CRC is appended. LoRaWAN convention: true for uplinks, false
   *  for downlinks. Defaults to true. */
  crcEnabled?: boolean | undefined;
  /**
   * Low-data-rate optimization. Undefined follows Semtech's own rule, which is
   * stated in terms of SYMBOL TIME, not spreading factor: LDRO is mandated once
   * a symbol exceeds 16 ms, because that is where oscillator drift over a single
   * symbol starts to matter.
   *
   * Writing the rule as "SF >= 11 at 125 kHz" reproduces the right answer for
   * every 125 kHz case and is wrong for SF12 at 250 kHz — a 16.384 ms symbol
   * that does need LDRO. Since DE changes the payload-symbol denominator, the
   * error silently understates airtime, which is the direction that quietly
   * breaks a duty-cycle budget.
   */
  lowDataRateOptimize?: boolean | undefined;
}

export interface LoraAirtimeResult {
  /** duration of one symbol, seconds */
  symbolTimeS: number;
  /** duration of the preamble, seconds */
  preambleTimeS: number;
  /** number of symbols the header+payload occupies */
  payloadSymbolCount: number;
  /** duration of the header+payload portion, seconds */
  payloadTimeS: number;
  /** total time on air: preamble + payload, seconds */
  timeOnAirS: number;
}

export function loraAirtime(input: LoraAirtimeInput): LoraAirtimeResult {
  const sf = input.spreadingFactor;
  const bw = input.bandwidthHz;
  const cr = input.codingRateDenominator ?? 5;
  const nPreamble = input.preambleSymbols ?? 8;
  const explicitHeader = input.explicitHeader ?? true;
  const crc = input.crcEnabled ?? true;
  const symbolTimeS = Math.pow(2, sf) / bw;
  const de = input.lowDataRateOptimize ?? symbolTimeS > LDRO_SYMBOL_TIME_S;
  const preambleTimeS = (nPreamble + 4.25) * symbolTimeS;

  const h = explicitHeader ? 0 : 1;
  const crcTerm = crc ? 16 : 0;
  const deTerm = de ? 1 : 0;
  const crVal = cr - 4; // 1..4, for 4/5..4/8

  const numerator = 8 * input.packetSizeBytes - 4 * sf + 28 + crcTerm - 20 * h;
  const denominator = 4 * (sf - 2 * deTerm);
  const payloadSymbolCount = 8 + Math.max(Math.ceil(numerator / denominator) * (crVal + 4), 0);
  const payloadTimeS = payloadSymbolCount * symbolTimeS;

  return {
    symbolTimeS,
    preambleTimeS,
    payloadSymbolCount,
    payloadTimeS,
    timeOnAirS: preambleTimeS + payloadTimeS,
  };
}

export interface DutyCycleBudgetInput {
  /** time on air of one transmission, seconds */
  timeOnAirS: number;
  /**
   * regulatory duty-cycle limit as a fraction of time, e.g. 0.01 for 1%.
   * Defaults to 0.01 — EU868's default sub-band limit (ETSI EN 300 220,
   * the 868.0-868.6 MHz "g1" band most LoRaWAN EU868 traffic uses). Some
   * EU868 sub-bands allow 0.1% or 10%; pass the real figure for those.
   */
  dutyCycleFraction?: number | undefined;
}

export interface DutyCycleBudgetResult {
  /** minimum time between the START of consecutive transmissions that
   *  respects the duty cycle, seconds. Derived exactly from duty =
   *  airtime / interval, not an approximation. */
  minIntervalS: number;
  /** total seconds of airtime permitted per hour */
  maxAirtimeSPerHour: number;
  /** how many transmissions of this airtime fit in one hour without
   *  exceeding the duty cycle, rounded down: a design cannot send a
   *  fractional packet to use up the remaining budget. */
  maxTransmissionsPerHour: number;
}

export function euDutyCycleBudget(input: DutyCycleBudgetInput): DutyCycleBudgetResult {
  const dutyCycleFraction = input.dutyCycleFraction ?? 0.01;
  const minIntervalS = input.timeOnAirS / dutyCycleFraction;
  const maxAirtimeSPerHour = 3600 * dutyCycleFraction;
  const maxTransmissionsPerHour = Math.floor(3600 / minIntervalS);

  return { minIntervalS, maxAirtimeSPerHour, maxTransmissionsPerHour };
}
