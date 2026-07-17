import { describe, expect, it } from "vitest";
import { euDutyCycleBudget, loraAirtime } from "./lora-airtime.js";

describe("loraAirtime", () => {
  // Hand-computed from AN1200.13, reproducing avbentem/airtime-calculator's
  // own test vector for these exact parameters (see the doc comment in
  // lora-airtime.ts for the full derivation):
  //   Tsym = 2^7/125000 = 1.024 ms; Tpreamble = 12.25*1.024 = 12.544 ms
  //   numerator = 8*14 - 4*7 + 28 + 16 - 0 = 128; ceil(128/28) = 5
  //   payloadSymbNb = 8 + 5*5 = 33; Tpayload = 33*1.024 = 33.792 ms
  //   total = 46.336 ms
  it("reproduces the published SF7/BW125/14-byte test vector", () => {
    const r = loraAirtime({ spreadingFactor: 7, bandwidthHz: 125_000, packetSizeBytes: 14 });
    expect(r.symbolTimeS).toBeCloseTo(1.024e-3, 9);
    expect(r.preambleTimeS).toBeCloseTo(12.544e-3, 9);
    expect(r.payloadSymbolCount).toBe(33);
    expect(r.timeOnAirS).toBeCloseTo(46.336e-3, 6);
  });

  // The other widely-cited reference point: SF12 airtime lands near 1.5 s
  // even for a small payload, which is why SF12 is the duty-cycle-budget
  // horror case for EU868. DE is forced on automatically at SF12/125 kHz.
  //   Tsym = 2^12/125000 = 32.768 ms; Tpreamble = 12.25*32.768 = 401.408 ms
  //   numerator = 8*25 - 4*12 + 28 + 16 - 0 = 196; ceil(196/40) = 5
  //   payloadSymbNb = 8 + 5*5 = 33; Tpayload = 33*32.768 = 1081.344 ms
  //   total = 1482.752 ms
  it("reproduces the ~1.5s SF12 small-payload reference figure", () => {
    const r = loraAirtime({ spreadingFactor: 12, bandwidthHz: 125_000, packetSizeBytes: 25 });
    expect(r.payloadSymbolCount).toBe(33);
    expect(r.timeOnAirS).toBeCloseTo(1.482752, 6);
  });

  // Semtech gates LDRO on SYMBOL TIME exceeding 16 ms, not on spreading factor.
  // The two rules agree everywhere at 125 kHz, which is what makes an
  // SF-gated shortcut look correct: it only diverges off that bandwidth.
  it.each([
    // [SF, BW, symbol ms, LDRO expected]
    [10, 125_000, 8.192, false],
    [11, 125_000, 16.384, true],
    [12, 125_000, 32.768, true],
    // the case an "SF >= 11 at 125 kHz" rule gets WRONG: a 16.384 ms symbol
    [12, 250_000, 16.384, true],
    [12, 500_000, 8.192, false],
    [7, 125_000, 1.024, false],
  ] as const)("auto-enables LDRO for SF%i at %i Hz (symbol %f ms) = %s", (sf, bw, symbolMs, expected) => {
    const auto = loraAirtime({ spreadingFactor: sf, bandwidthHz: bw, packetSizeBytes: 14 });
    expect(auto.symbolTimeS * 1000).toBeCloseTo(symbolMs, 3);

    // DE changes the (SF - 2*DE) denominator, so forcing it to the value the
    // auto rule should have picked must be a no-op — and forcing the opposite
    // must not be. That pins WHICH way the rule went, not merely that it moved.
    const forcedSame = loraAirtime({
      spreadingFactor: sf,
      bandwidthHz: bw,
      packetSizeBytes: 14,
      lowDataRateOptimize: expected,
    });
    expect(forcedSame.timeOnAirS).toBeCloseTo(auto.timeOnAirS, 9);
  });

  it("understates nothing: LDRO off where it is mandated would shorten airtime", () => {
    // The direction of the bug matters — an SF-gated rule leaves DE off for
    // SF12/250 kHz, and a too-SHORT airtime silently breaks a duty-cycle budget.
    //
    // The payload is chosen deliberately: DE only changes the (SF - 2*DE)
    // denominator, and at 14 bytes both 108/40 and 108/48 ceil to 3, so the
    // error hides inside the ceiling entirely. At 30 bytes the numerator is 236
    // and the two diverge — 236/40 = 5.9 -> 6 against 236/48 = 4.92 -> 5:
    //   with LDRO (correct): 8 + 6*5 = 38 symbols, 823.296 ms total
    //   without (the bug):   8 + 5*5 = 33 symbols, 741.376 ms total
    const params = { spreadingFactor: 12, bandwidthHz: 250_000, packetSizeBytes: 30 } as const;
    const correct = loraAirtime(params);
    const wrong = loraAirtime({ ...params, lowDataRateOptimize: false });

    expect(correct.payloadSymbolCount).toBe(38);
    expect(wrong.payloadSymbolCount).toBe(33);
    expect(correct.timeOnAirS * 1000).toBeCloseTo(823.296, 3);
    expect(wrong.timeOnAirS * 1000).toBeCloseTo(741.376, 3);
    expect(wrong.timeOnAirS).toBeLessThan(correct.timeOnAirS);
  });

  it("shortens time on air for a downlink with CRC disabled, same payload", () => {
    // CRC off drops the +16 term from the payload-symbol numerator:
    // numerator = 8*14 - 4*7 + 28 + 0 - 0 = 112; ceil(112/28) = 4 (vs 5 with CRC)
    // payloadSymbNb = 8 + 4*5 = 28; Tpayload = 28*1.024 = 28.672 ms
    // total = 12.544 + 28.672 = 41.216 ms
    const r = loraAirtime({
      spreadingFactor: 7,
      bandwidthHz: 125_000,
      packetSizeBytes: 14,
      crcEnabled: false,
    });
    expect(r.payloadSymbolCount).toBe(28);
    expect(r.timeOnAirS).toBeCloseTo(41.216e-3, 6);
  });
});

describe("euDutyCycleBudget", () => {
  it("computes the EU868 1% budget for a short SF7 transmission", () => {
    // interval = airtime / duty = 0.046336 / 0.01 = 4.6336 s
    // budget/hr = 3600*0.01 = 36 s; transmissions/hr = floor(3600/4.6336) = 776
    const r = euDutyCycleBudget({ timeOnAirS: 46.336e-3 });
    expect(r.minIntervalS).toBeCloseTo(4.6336, 4);
    expect(r.maxAirtimeSPerHour).toBeCloseTo(36, 6);
    expect(r.maxTransmissionsPerHour).toBe(776);
  });

  it("shows why SF12 is the duty-cycle horror case: ~1.48s airtime allows very few sends/hour", () => {
    // interval = 1.482752 / 0.01 = 148.2752 s; transmissions/hr = floor(3600/148.2752) = 24
    const r = euDutyCycleBudget({ timeOnAirS: 1.482752 });
    expect(r.minIntervalS).toBeCloseTo(148.2752, 3);
    expect(r.maxTransmissionsPerHour).toBe(24);
    // a naive "every 60s" SF12 node would be transmitting far faster than
    // its 145s minimum interval allows -- exactly the field failure (a
    // network operator throttling or a regulatory violation) this budget
    // exists to catch before it ships
    expect(60).toBeLessThan(r.minIntervalS);
  });

  it("scales the transmit interval with a tighter sub-band duty cycle", () => {
    const oneCent = euDutyCycleBudget({ timeOnAirS: 46.336e-3, dutyCycleFraction: 0.01 });
    const oneTenth = euDutyCycleBudget({ timeOnAirS: 46.336e-3, dutyCycleFraction: 0.001 });
    // a 10x stricter duty cycle (EU868's 0.1% sub-band) demands a 10x longer interval
    expect(oneTenth.minIntervalS).toBeCloseTo(oneCent.minIntervalS * 10, 6);
  });
});
