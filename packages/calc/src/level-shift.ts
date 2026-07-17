/**
 * Level-shift detection between a digital driver and a receiver.
 *
 * The bug this exists to catch is not "incompatible voltages" — that one is
 * loud and obvious. It is the pair that LOOKS fine and isn't, or looks broken
 * and would actually work: a 3.3 V driver talking to a "5 V" receiver reads as
 * one problem on the silkscreen and is really two different outcomes
 * depending on the receiver's logic family, because VIH is not "5 V minus
 * something", it is whatever fraction of the receiver's OWN VDD that family's
 * spec defines it as:
 *
 *   - 5 V TTL (74LS/74HCT-input parts): VIH = 2.0 V (an absolute spec value,
 *     not VDD-relative). A 3.3 V driver's guaranteed VOH of ~2.4-3.3 V clears
 *     2.0 V with room to spare — it "works by luck", not by margin someone
 *     designed in.
 *   - 5 V CMOS (74HC-input parts): VIH = 0.7 * VDD = 3.5 V. The SAME 3.3 V
 *     driver now fails to reach VIH at all — a marginal high that a scope
 *     might not even catch, because CMOS gates don't fail loudly, they read
 *     ambiguous logic and misbehave intermittently. This is the classic trap:
 *     the exact same driver is fine into one "5 V" part and broken into
 *     another, and nothing about "3.3 V to 5 V" as a phrase tells you which.
 *
 * This module does not know a receiver's logic family — it only knows the
 * VIH/VIL/absolute-max numbers the caller supplies, which is deliberate: the
 * caller is expected to have pulled the real numbers for the real receiver
 * rather than assuming a family from a nominal voltage. When those numbers
 * are not supplied, the answer is UNKNOWN, never "compatible" — silently
 * treating an unspecified receiver as compatible is the same bug class as
 * inventing a resistor value: a confidently wrong answer standing in for an
 * honest gap.
 */

export interface DriverLevels {
  /** guaranteed output HIGH voltage (datasheet VOH, worst case), volts */
  vohV: number;
  /** guaranteed output LOW voltage (datasheet VOL, worst case), volts */
  volV: number;
}

export interface ReceiverThresholds {
  /** minimum voltage the receiver guarantees it reads as HIGH, volts.
   *  Unknown when the caller has not looked it up for this specific part. */
  vihV?: number | undefined;
  /** maximum voltage the receiver guarantees it reads as LOW, volts */
  vilV?: number | undefined;
  /** absolute maximum voltage the receiver's input can tolerate before
   *  damage, volts (datasheet "Absolute Maximum Ratings", not VIH) */
  absoluteMaxV?: number | undefined;
}

export type LevelShiftVerdict = "compatible" | "needs-level-shift" | "damage-risk" | "unknown";

export interface LevelShiftResult {
  verdict: LevelShiftVerdict;
  /** human-readable reason for the verdict, naming the specific margin or gap */
  reason: string;
  /** VOH - VIH; positive means the driver's high clears the receiver's
   *  threshold. Null when VIH is unknown. */
  highMarginV: number | null;
  /** VIL - VOL; positive means the driver's low is safely under the
   *  receiver's threshold. Null when VIL is unknown. */
  lowMarginV: number | null;
  /** receiver absoluteMaxV - driver VOH; negative means the driver can
   *  exceed what the receiver survives. Null when absoluteMaxV is unknown. */
  overvoltageMarginV: number | null;
}

export function levelShift(driver: DriverLevels, receiver: ReceiverThresholds): LevelShiftResult {
  const highMarginV = receiver.vihV !== undefined ? driver.vohV - receiver.vihV : null;
  const lowMarginV = receiver.vilV !== undefined ? receiver.vilV - driver.volV : null;
  const overvoltageMarginV =
    receiver.absoluteMaxV !== undefined ? receiver.absoluteMaxV - driver.vohV : null;

  // Damage takes priority over everything else, and is reported even if the
  // logic thresholds are unknown: a driver that can exceed the receiver's
  // absolute max will damage it regardless of whether the logic levels would
  // otherwise have worked.
  if (overvoltageMarginV !== null && overvoltageMarginV < 0) {
    return {
      verdict: "damage-risk",
      reason:
        `driver VOH ${driver.vohV} V exceeds the receiver's absolute maximum ` +
        `${receiver.absoluteMaxV} V by ${(-overvoltageMarginV).toFixed(3)} V`,
      highMarginV,
      lowMarginV,
      overvoltageMarginV,
    };
  }

  if (receiver.vihV === undefined || receiver.vilV === undefined) {
    const missing = [
      receiver.vihV === undefined ? "VIH" : null,
      receiver.vilV === undefined ? "VIL" : null,
    ]
      .filter((x): x is string => x !== null)
      .join(" and ");
    return {
      verdict: "unknown",
      reason: `receiver ${missing} not specified — logic compatibility cannot be determined`,
      highMarginV,
      lowMarginV,
      overvoltageMarginV,
    };
  }

  if (overvoltageMarginV === null) {
    return {
      verdict: "unknown",
      reason:
        "receiver absolute maximum voltage not specified — cannot rule out overvoltage damage " +
        "even though the logic thresholds look compatible",
      highMarginV,
      lowMarginV,
      overvoltageMarginV,
    };
  }

  const highOk = highMarginV !== null && highMarginV >= 0;
  const lowOk = lowMarginV !== null && lowMarginV >= 0;

  if (highOk && lowOk) {
    return {
      verdict: "compatible",
      reason: `VOH clears VIH by ${(highMarginV as number).toFixed(3)} V and VOL clears VIL by ${(lowMarginV as number).toFixed(3)} V`,
      highMarginV,
      lowMarginV,
      overvoltageMarginV,
    };
  }

  const problems: string[] = [];
  if (!highOk) problems.push(`VOH ${driver.vohV} V does not reach VIH ${receiver.vihV} V`);
  if (!lowOk) problems.push(`VOL ${driver.volV} V does not stay under VIL ${receiver.vilV} V`);

  return {
    verdict: "needs-level-shift",
    reason: problems.join("; "),
    highMarginV,
    lowMarginV,
    overvoltageMarginV,
  };
}
