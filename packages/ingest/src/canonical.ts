import type { PowerMode } from "@embedded/core";

/**
 * Map a datasheet's own wording onto the app's canonical parameter ids.
 *
 * This is the cheap half of normalization. Datasheets are stereotyped: the
 * Symbol column is nearly a controlled vocabulary already (VDD, VDDIO, IDDSL,
 * tSTARTUP), and where a symbol is absent the label is usually one of a few
 * dozen phrasings. Resolving those here means the LLM tier only ever sees the
 * genuinely novel rows, which is what keeps bulk ingest fast and free.
 *
 * Deliberately conservative: an unrecognised row returns null rather than a
 * guess, and the caller hands it to the LLM tier. A wrong canonical id silently
 * merges two different specs — far worse than an unresolved one.
 */

/** Symbol → canonical id. The symbol column is the strongest available signal. */
const BY_SYMBOL: Record<string, string> = {
  vdd: "vdd",
  vcc: "vdd",
  "vdd_io": "vddio",
  vddio: "vddio",
  vio: "vddio",
  vbat: "vbat",
  vin: "vin",
  vout: "vout",
  vih: "vih",
  vil: "vil",
  voh: "voh",
  vol: "vol",
  iddsl: "iSleep",
  iddsb: "iStandby",
  iddh: "iActiveHumidity",
  iddp: "iActivePressure",
  iddt: "iActiveTemperature",
  idd: "iActive",
  icc: "iActive",
  iq: "iQuiescent",
  tstartup: "tStartup",
  tstandby: "tStandby",
  ta: "tAmbient",
  tstg: "tStorage",
  topr: "tOperating",
  tj: "tJunction",
  psrr: "psrr",
  fscl: "i2cClock",
  fsck: "spiClock",
};

/**
 * Label patterns → canonical id, tried in order. First match wins, so the more
 * specific pattern must come first ("storage temperature" before "temperature").
 */
const BY_LABEL: Array<{ pattern: RegExp; param: string }> = [
  { pattern: /storage\s+temp/i, param: "tStorage" },
  { pattern: /junction\s+temp/i, param: "tJunction" },
  { pattern: /ambient\s+temp/i, param: "tAmbient" },
  { pattern: /operating\s+temp|temperature\s+range/i, param: "tOperating" },
  { pattern: /\bi\/?o\s+domain|interface\s+(pin|supply)|vddio/i, param: "vddio" },
  { pattern: /supply\s+voltage|voltage\s+at\s+any\s+supply/i, param: "vdd" },
  { pattern: /input\s+voltage/i, param: "vin" },
  { pattern: /output\s+voltage/i, param: "vout" },
  { pattern: /sleep\s+current/i, param: "iSleep" },
  { pattern: /standby\s+current/i, param: "iStandby" },
  { pattern: /quiescent\s+current/i, param: "iQuiescent" },
  { pattern: /supply\s+current|active\s+current/i, param: "iActive" },
  { pattern: /start-?up\s+time/i, param: "tStartup" },
  { pattern: /humidity/i, param: "humidity" },
  { pattern: /\bpressure\b/i, param: "pressure" },
  { pattern: /\besd\b/i, param: "esd" },
  { pattern: /power\s+supply\s+rejection/i, param: "psrr" },
];

/**
 * A row's canonical id, or null when nothing matches confidently.
 *
 * The `vddio` label rule must be consulted before `vdd`, because a datasheet
 * writes both supply rows with the identical label "Supply Voltage" and
 * distinguishes them only by symbol or by a continuation line ("Internal
 * Domains" vs "I/O Domain") — real BME280 p8. Passing the merged label text in
 * is therefore load-bearing, not incidental.
 */
export function canonicalParam(opts: { symbol?: string | undefined; label?: string | undefined }): string | null {
  const symbol = opts.symbol?.trim().toLowerCase().replace(/[\s_]+/g, "");
  if (symbol) {
    const bySymbol = BY_SYMBOL[symbol];
    if (bySymbol) return bySymbol;
  }
  const label = opts.label?.trim();
  if (label) {
    for (const { pattern, param } of BY_LABEL) {
      if (pattern.test(label)) return param;
    }
  }
  return null;
}

/**
 * Canonical operating MODE for a current row, or null.
 *
 * This is the coarse bucket a power budget sums by ("what is the part doing"),
 * NOT the row's identity: one table prints several distinct supply currents
 * that all bucket to `active`. The extractor keeps the datasheet's own wording
 * as the row name and stores this alongside it.
 */
const POWER_STATE: Array<{ pattern: RegExp; mode: PowerMode }> = [
  { pattern: /sleep|shutdown/i, mode: "sleep" },
  // "stdby" is Semtech's spelling, and theirs is the only wording on the row:
  // the SX1262's standby states are named STDBY_RC and STDBY_XOSC and never
  // spelled out, so matching only "standby" leaves a radio's standby current
  // with no mode and drops it from the budget.
  { pattern: /standby|stdby|idle/i, mode: "standby" },
  { pattern: /\btx\b|transmit/i, mode: "tx" },
  { pattern: /\brx\b|receive/i, mode: "rx" },
  { pattern: /refresh/i, mode: "refresh" },
  // A regulator's quiescent current is what it costs to be switched on at all —
  // it is drawn continuously, so it is the part's `active` draw and the role's
  // duty default keeps it continuous. Without this a regulator documents no mode
  // the budget recognises and drops out of the estimate entirely, which reads to
  // the user as a part that is free to include.
  { pattern: /quiescent/i, mode: "active" },
  { pattern: /measur|convers|active|normal|forced|operating/i, mode: "active" },
];

export function canonicalPowerState(text: string): PowerMode | null {
  for (const { pattern, mode } of POWER_STATE) {
    if (pattern.test(text)) return mode;
  }
  return null;
}

/**
 * Does this row's unit read like a current? Decides rated-param vs power-state.
 *
 * The internal space is not paranoia: pdfjs reports "μA" as two runs whenever the
 * mu comes from a different font than the A, so the cell arrives as "μ A". A
 * regulator's entire µA vocabulary — quiescent and shutdown current, the only
 * rows a sleep budget can use — was being rejected on that space, leaving TI's
 * `ISW Average switch current limit` (unit "mA", one run, so it passed) as the
 * part's ONLY current row. That is how a 4 A switch limit became a regulator's
 * sleep draw. The unit is a token, not prose: strip whitespace before matching.
 */
export function looksLikeCurrent(unit: string): boolean {
  return /^[munpµμ]?A$/.test(normalizeUnit(unit));
}

/** A unit cell as a single token: no internal spaces, mu normalized to µ. */
export function normalizeUnit(unit: string): string {
  return unit.replace(/\s+/g, "").replace(/μ/g, "µ");
}
