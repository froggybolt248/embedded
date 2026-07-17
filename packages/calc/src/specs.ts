import type { ComponentSpecs, PowerMode, PowerState, SourcedRange, ValueSource } from "@embedded/core";

/**
 * Turn a component's grounded power-state table into calculator inputs.
 *
 * The hard rule here is that a missing number stays missing. It is tempting to
 * fall back — "no sleep row? use the smallest current on the part" — and that
 * fallback is exactly how a regulator's `ISHORT Short Current Limit 50 mA`
 * became its sleep current, making a coin-cell design draw 50 mA forever, with
 * a citation attached to prove it. An uncited gap is honest; a confidently
 * cited wrong number is not. So every lookup below is keyed on the part
 * actually documenting the mode being asked about, and returns null otherwise.
 */

const SLEEP = /sleep|standby|idle|shutdown|deep|hibernat|\boff\b/i;
const ACTIVE = /active|run|tx|transmit|rx|receiv|measur|convert|normal|forced|operat|wake|burst/i;

/**
 * Normalise a current to mA from A / mA / µA / uA / nA (best-effort otherwise).
 *
 * Internal whitespace is stripped, not just trimmed: pdfjs splits "μA" into two
 * runs when the mu and the A come from different fonts, so rows already in the
 * library carry the unit as "μ A". Reading that as bare amps would overstate a
 * sleep current by a millionfold.
 */
export function currentToMa(value: number, unit: string): number {
  const u = unit.replace(/\s+/g, "").toLowerCase().replace(/μ/g, "µ");
  if (/^a$/.test(u)) return value * 1000;
  if (/^ma$/.test(u)) return value;
  if (/^[µu]a$/.test(u)) return value / 1000;
  if (/^na$/.test(u)) return value / 1_000_000;
  if (/^pa$/.test(u)) return value / 1_000_000_000;
  return value; // unknown unit — assume already mA rather than dropping the row
}

/** Normalise a time to ms from s / ms / µs / ns. Null for a unit we cannot read. */
export function timeToMs(value: number, unit: string): number | null {
  const u = unit.replace(/\s+/g, "").toLowerCase().replace(/μ/g, "µ");
  if (u === "s" || u === "sec") return value * 1000;
  if (u === "ms") return value;
  if (u === "µs" || u === "us") return value / 1000;
  if (u === "ns") return value / 1_000_000;
  // Unlike a current, there is no sensible "assume it's already ms" here: an
  // unreadable time unit would silently mis-scale a wake window by 1000×.
  return null;
}

/** A grounded floor on how long a part must stay awake, with its citation. */
export interface WakeFloor {
  ms: number;
  /** the datasheet's own row name */
  name: string;
  source: ValueSource;
}

/**
 * The startup time the part documents — a grounded LOWER BOUND on `forMs`.
 *
 * Deliberately not "the wake duration": startup is only the part of the awake
 * window spent becoming ready, and how long the design then keeps it awake to do
 * work is a design decision, not a datasheet fact. Presenting this as the answer
 * would be inventing the rest.
 *
 * What it IS good for is catching an impossible assumption. A duty of "awake
 * 0.5 ms every 60 s" against a part that needs 2 ms just to start up is not a
 * slightly-off estimate, it is a budget for a design that cannot work — and the
 * error flatters the design, because a too-short wake understates the draw.
 * Worst case (max, else typ) because a floor built from the best case is not a
 * floor.
 */
export function startupFloorFromSpecs(specs: ComponentSpecs): WakeFloor | null {
  const row = specs.recommendedOperating.find((r) => r.param === "tStartup");
  if (row === undefined) return null;
  const sv = row.range.max ?? row.range.typ;
  if (sv === undefined) return null;
  const ms = timeToMs(sv.value, sv.unit);
  if (ms === null) return null;
  return { ms, name: row.label, source: sv.source };
}

/** Representative current of a min/typ/max range: typ, else max, else min. */
function pick(range: SourcedRange): { value: number; unit: string; source: ValueSource } | null {
  const sv = range.typ ?? range.max ?? range.min;
  return sv ? { value: sv.value, unit: sv.unit, source: sv.source } : null;
}

/**
 * The mode a row belongs to. Prefers the extractor's canonical `mode`; reads
 * the row name only for rows written before `mode` existed. Rows that name no
 * mode we recognise return undefined and are ignored rather than guessed at —
 * "Short Current Limit" is not a power state, and pretending otherwise is the
 * bug this whole module is shaped around avoiding.
 */
function modeOf(ps: PowerState): PowerMode | undefined {
  if (ps.mode !== undefined) return ps.mode;
  if (SLEEP.test(ps.name)) return "sleep";
  if (ACTIVE.test(ps.name)) return "active";
  return undefined;
}

/** The worst-case current for one operating mode, with its citation. */
export interface ModeCurrent {
  mode: PowerMode;
  /** the datasheet's own row name for the worst-case row in this mode */
  name: string;
  ma: number;
  source: ValueSource;
}

const AWAKE_MODES: PowerMode[] = ["active", "tx", "rx", "refresh"];
const SLEEP_MODES: PowerMode[] = ["sleep", "standby"];

interface Row {
  mode: PowerMode;
  name: string;
  ma: number;
  source: ValueSource;
}

function rows(specs: ComponentSpecs): Row[] {
  const out: Row[] = [];
  for (const ps of specs.powerStates) {
    const mode = modeOf(ps);
    const picked = pick(ps.current);
    if (mode === undefined || !picked) continue;
    out.push({ mode, name: ps.name, ma: currentToMa(picked.value, picked.unit), source: picked.source });
  }
  return out;
}

/**
 * Every awake mode the part documents, each reduced to its worst-case draw.
 *
 * Per-mode because a radio's `tx` and `rx` are different currents on different
 * duty cycles; collapsing them to one "active" number is what makes a TX burst
 * look like a continuous load. Worst-case within a mode because a budget
 * should not quietly assume the best case.
 */
export function modeCurrentsFromSpecs(specs: ComponentSpecs): ModeCurrent[] {
  const byMode = new Map<PowerMode, ModeCurrent>();
  for (const row of rows(specs)) {
    if (!AWAKE_MODES.includes(row.mode)) continue;
    const existing = byMode.get(row.mode);
    if (existing === undefined || row.ma > existing.ma) byMode.set(row.mode, row);
  }
  return [...byMode.values()];
}

/**
 * Best-case (lowest) documented sleep draw, or null when the part documents no
 * sleep or standby mode at all. Null means "unknown", never "zero" and never
 * "some other row that happened to be small".
 */
export function sleepCurrentFromSpecs(specs: ComponentSpecs): ModeCurrent | null {
  const candidates = rows(specs).filter((r) => SLEEP_MODES.includes(r.mode));
  if (candidates.length === 0) return null;
  return candidates.reduce((a, b) => (b.ma < a.ma ? b : a));
}
