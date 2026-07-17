import type { DatasheetSection } from "@embedded/core";
import { canonicalParam, canonicalPowerState, looksLikeCurrent, normalizeUnit } from "./canonical.js";
import { pinFunctionByName } from "./kicad.js";
import type { LoadedPdf } from "./pdf.js";
import { hasUsableTextLayer } from "./pdf.js";
import { mergeSection } from "./pipeline.js";
import {
  ExtractionFields,
  type ExtractedPin,
  type ExtractedPowerState,
  type ExtractedRatedParam,
  type ExtractedVariant,
  type SectionExtraction,
} from "./schemas.js";
import { extractTables, parseCell, type ExtractedTable, type TableRow } from "./tables.js";
import { triageFromOutline, triageFromText } from "./triage.js";

/**
 * Tier 0 + Tier 1 — datasheet extraction with no LLM in the loop.
 *
 * This is the channel that makes bulk ingest free. Tier 0 (the PDF outline, or
 * a keyword fallback) says which pages hold which section; Tier 1 reads the
 * spec tables off those pages' text layers at known coordinates and maps them
 * onto canonical parameter ids. Nothing is transcribed by a model, so every row
 * it emits is grounded by construction and marked `extractor: "deterministic"`
 * — which is what lets the commit step auto-accept it as `verifiedBy: 'machine'`
 * rather than parking it for human review.
 *
 * It reports what it could NOT do as precisely as what it could: `gapPages` are
 * spec pages that yielded no table (a package drawing, a scan, an odd layout)
 * and `unclassified` are pages Tier 0 couldn't place. Those two lists are the
 * exact, minimal work the vision tier must still do — everything else stays
 * off the slow path.
 */

/**
 * Version of the free extraction tier. Bump whenever a change alters what Tier 1
 * reads off the same PDF — a new canonical mapping, a table-shape fix.
 *
 * This is what makes recall improvements reach parts that are already in the
 * library. Grounding is triggered once, by binding a part, and never repeats:
 * without a version to compare against, a part read by an older extractor stays
 * frozen with whatever that extractor missed, and every fix here only ever helps
 * parts nobody has used yet. Recorded on the ExtractionRun as `model`, because
 * "which engine produced this row" is exactly what that audit trail is for.
 *
 * - d1: initial deterministic tier
 * - d2: unit tokens ("μ A"), vertically merged labels, quiescent/shutdown modes
 * - d3: Symbol-font PUA glyphs (µ as U+F06D), footnote paragraphs under a table,
 *       page-height furniture band
 * - d4: dedicated Mode column, STDBY vocabulary
 * - d5: row names deduplicated; the Mode column no longer stands in for a
 *       missing symbol
 * - d6: "mode" is a header word, so a table headed "Work Mode | Description |
 *       Peak (mA)" is found at all; section headings and body prose below a
 *       table are cut by the left margin; footnote markers printed as detached
 *       superscripts (Espressif) end a table like any other footnote
 *
 * Bump rather than redefine. A version already written to an ExtractionRun is a
 * claim about how those rows were produced, and rows stamped d3 exist; making d3
 * mean something else retroactively would both falsify that audit trail and
 * leave the parts it names looking current, so the fix never reaches them.
 */
export const EXTRACTOR_VERSION = "d6";

/** ExtractionRun.model for a Tier 0+1 run, carrying the version that produced it. */
export const DETERMINISTIC_MODEL = `deterministic@${EXTRACTOR_VERSION}`;

export interface DeterministicResult {
  fields: ExtractionFields;
  sectionMap: Record<string, DatasheetSection>;
  triageSource: "outline" | "keywords";
  /** spec-section pages that produced no usable table — vision candidates */
  gapPages: number[];
  /** spec pages Tier 1 read at least one row off — vision may skip these */
  handledPages: number[];
  /** pages Tier 0 could not classify (only ever non-empty on the keyword path) */
  unclassified: number[];
  /** how many tables Tier 1 mapped — a quick "did the free path do anything" signal */
  tableCount: number;
}

/** Sections whose content is a coordinate-addressable table Tier 1 can read. */
const TABLE_SECTIONS: readonly DatasheetSection[] = [
  "absolute-max",
  "recommended-operating",
  "electrical-characteristics",
  "power",
  "pinout",
  "ordering",
];

export interface DeterministicProgress {
  stage: "deterministic";
  detail: string;
  done: number;
  total: number;
}

export async function extractDeterministic(
  pdf: LoadedPdf,
  opts: { onProgress?: (p: DeterministicProgress) => void } = {},
): Promise<DeterministicResult> {
  // ---- Tier 0: classify pages, preferring the authored outline -------------
  const outline = await pdf.outline();
  let triage = triageFromOutline(outline, pdf.pageCount);
  if (!triage) {
    const texts: Array<{ page: number; text: string }> = [];
    for (let p = 1; p <= pdf.pageCount; p++) texts.push({ page: p, text: await pdf.pageText(p) });
    triage = triageFromText(texts);
  }

  const sectionMap = triage.sectionMap;
  const fields = ExtractionFields.parse({});
  const gapPages: number[] = [];
  const handledPages: number[] = [];
  let tableCount = 0;

  const targets = Object.entries(sectionMap)
    .filter(([, section]) => TABLE_SECTIONS.includes(section))
    .map(([page, section]) => ({ page: Number(page), section }))
    .sort((a, b) => a.page - b.page);

  // ---- Tier 1: read tables off each spec page ------------------------------
  let done = 0;
  for (const { page, section } of targets) {
    opts.onProgress?.({
      stage: "deterministic",
      detail: `reading ${section} on page ${page}`,
      done,
      total: targets.length,
    });
    done++;

    const items = await pdf.pageItems(page);
    // an image-only page (a scan, a package drawing) carries no text to read;
    // it is exactly what the vision tier is for
    if (!hasUsableTextLayer(items)) {
      gapPages.push(page);
      continue;
    }

    const tables = extractTables(items, page, { pageHeight: await pdf.pageHeight(page) });
    let mappedAny = false;
    for (const table of tables) {
      const part = mapTable(table, section);
      if (sectionHasRows(part)) {
        mergeSection(fields, part);
        mappedAny = true;
        tableCount++;
      }
    }
    // text is present but nothing table-shaped mapped — let vision try the page
    if (mappedAny) handledPages.push(page);
    else gapPages.push(page);
  }

  return {
    fields,
    sectionMap,
    triageSource: triage.source,
    gapPages,
    handledPages,
    unclassified: triage.unclassified,
    tableCount,
  };
}

// ---- column-role identification ------------------------------------------

interface ColumnRoles {
  symbol?: number;
  /**
   * A column headed "Mode" — the operating state this row measures. Semtech
   * gives the SX1262 power table its own such column ("SLEEP mode with cold
   * start", "STDBY_RC mode", "Receive mode"), which is the ONLY place those
   * words appear: the symbol is "IDDSL" and the conditions read "Configuration
   * retained". Unclaimed, the column is dropped and every sleep and standby row
   * lands with no mode at all — present in the library, invisible to the budget,
   * which reads as a radio that costs nothing to leave switched on.
   */
  mode?: number;
  label?: number;
  conditions?: number;
  min?: number;
  typ?: number;
  max?: number;
  unit?: number;
  name?: number;
  number?: number;
  fn?: number;
  /**
   * Per-column unit taken from the column's own header ("Typ (µA)"), for the
   * many tables that have no Unit column at all. Indexed like the headers.
   */
  unitByCol?: Array<string | undefined>;
}

/**
 * The unit a column states in its own header. Espressif heads the ESP32-C3's
 * current tables "Typ (µA)", "Peak (mA)" and "Disabled (mA)" and prints no Unit
 * column anywhere — so a reader that only looks for a Unit cell finds no unit,
 * rejects every row, and the part grounds with no current data at all despite
 * the numbers sitting right there.
 *
 * Reads the RAW header: `headers` is lower-cased for vocabulary matching, and
 * "µa" is not a unit — looksLikeCurrent is case-sensitive, as it must be ("mA"
 * and "MA" are not the same claim).
 */
function headerUnit(header: string): string | undefined {
  const match = /\(([^()]*)\)/.exec(header);
  if (match === null) return undefined;
  const unit = normalizeUnit(match[1] as string);
  return looksLikeCurrent(unit) ? unit : undefined;
}

/**
 * The current unit for a row: the Unit cell when the table has one, else the
 * unit its value column declares in the header. Returns undefined when the row
 * is not a current row at all, which is how a mixed table (voltages, timings and
 * currents under one header) keeps its non-current rows out of powerStates.
 */
function currentUnitFor(cells: string[], roles: ColumnRoles): string | undefined {
  const cellUnit = textAt(cells, roles.unit);
  if (cellUnit !== undefined) {
    return looksLikeCurrent(cellUnit) ? normalizeUnit(cellUnit) : undefined;
  }
  for (const col of [roles.typ, roles.max, roles.min]) {
    if (col === undefined) continue;
    const unit = roles.unitByCol?.[col];
    if (unit !== undefined) return unit;
  }
  return undefined;
}

/**
 * Assign each header cell a role by the small shared vocabulary spec tables
 * draw their column titles from. Getting min/typ/max wrong silently corrupts a
 * value, so the numeric roles match tightly (`min`/`max`/`typ`/`nom` as whole
 * words); text roles are looser. First cell to claim a role keeps it, so a
 * table with two "condition"-ish columns doesn't overwrite the first.
 */
function classifyColumns(rawHeaders: string[]): ColumnRoles {
  const roles: ColumnRoles = { unitByCol: rawHeaders.map(headerUnit) };
  rawHeaders.forEach((raw, i) => {
    const h = raw.trim().toLowerCase();
    if (h === "") return;
    if (roles.min === undefined && /\bmin\b\.?/.test(h)) roles.min = i;
    // "Peak" is a value column like Max, and the only one ESP32-C3's Wi-Fi table
    // has: "Work Mode | Description | Peak (mA)" is where the 335 mA TX draw
    // lives. Read as max because that is what a peak is — an upper figure, not a
    // typical one — and treating it as typ would understate a TX burst that the
    // bulk-cap and brownout math exists to catch.
    else if (roles.max === undefined && /\b(max|peak)\b\.?/.test(h)) roles.max = i;
    else if (roles.typ === undefined && /\b(typ|nom|nominal)\b\.?/.test(h)) roles.typ = i;
    else if (roles.unit === undefined && /\bunits?\b/.test(h)) roles.unit = i;
    else if (roles.number === undefined && /^(no\.?|number|pin|pins|#)$/.test(h)) roles.number = i;
    else if (roles.symbol === undefined && /\bsymbols?\b/.test(h)) roles.symbol = i;
    else if (roles.name === undefined && /\bname\b/.test(h)) roles.name = i;
    else if (roles.fn === undefined && /\bfunctions?\b/.test(h)) roles.fn = i;
    else if (roles.mode === undefined && /\bmodes?\b/.test(h)) roles.mode = i;
    else if (
      roles.label === undefined &&
      /\b(parameter|parameters|characteristic|characteristics|description|item|rating|ratings)\b/.test(h)
    )
      roles.label = i;
    else if (roles.conditions === undefined && /\b(condition|conditions|test|remark|remarks|note|notes)\b/.test(h))
      roles.conditions = i;
  });
  return roles;
}

function textAt(cells: string[], idx: number | undefined): string | undefined {
  if (idx === undefined) return undefined;
  const cell = cells[idx]?.trim();
  return cell ? cell : undefined;
}

function numAt(cells: string[], idx: number | undefined): number | null {
  const cell = textAt(cells, idx);
  if (cell === undefined) return null;
  const v = parseCell(cell);
  if (v.kind === "number" || v.kind === "plusminus") return v.value;
  return null;
}

/** The first ± value among the given columns, meaning a symmetric ±v range. */
function firstPlusMinus(cells: string[], idxs: Array<number | undefined>): number | null {
  for (const idx of idxs) {
    const cell = textAt(cells, idx);
    if (cell === undefined) continue;
    const v = parseCell(cell);
    if (v.kind === "plusminus") return v.value;
  }
  return null;
}

/**
 * The first non-empty, non-numeric cell not already claimed by another role.
 *
 * The Mode column is excluded along with the numeric ones. It has its own role
 * and is read separately, so letting it stand in for a missing symbol here names
 * the row after its mode twice over ("Receive mode — Receive mode — LoRa 125 kHz").
 */
function firstTextCell(cells: string[], roles: ColumnRoles): string | undefined {
  const numericCols = new Set([roles.min, roles.typ, roles.max, roles.unit, roles.mode]);
  for (let i = 0; i < cells.length; i++) {
    if (numericCols.has(i)) continue;
    const cell = cells[i]?.trim();
    if (!cell) continue;
    if (parseCell(cell).kind === "number") continue;
    return cell;
  }
  return undefined;
}

/** Verbatim-ish row text for the citation snippet (non-empty cells, in order). */
function rowSnippet(cells: string[]): string {
  return cells
    .map((c) => c.trim())
    .filter((c) => c !== "")
    .join(" ")
    .slice(0, 500);
}

function slug(text: string): string {
  const s = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return s || text.trim().slice(0, 40) || "param";
}

// ---- vertically merged cells ---------------------------------------------

/**
 * How many rows a merged label may be carried across. A merged cell spans a
 * handful of rows; past that, a blank label means something else entirely and
 * carrying would invent a relationship the layout never showed.
 */
const MERGE_REACH = 3;

/**
 * How much nearer the winning label must be than its rival. A blank row roughly
 * equidistant between two labels genuinely cannot be attributed from spacing
 * alone, and this codebase's rule is that an unattributed row is handed onward
 * while a misattributed one silently poisons the library.
 */
const MERGE_MARGIN = 2;

/**
 * Re-fill vertically merged label cells, which arrive blank on every row but one.
 *
 * A spec table writes one label beside a group of rows that share it — SX1276
 * prints `IDDT | Supply current in Transmit mode` once against four rows that
 * differ only by output power. The PDF has no merged-cell concept: the label
 * lands on whichever row it is vertically centred against, and its siblings come
 * through label-less. Those siblings then match no operating mode and are
 * dropped — and the dropped rows are the extremes, because the labelled row is
 * the middle one. The SX1276's real worst-case TX (120 mA at +20 dBm) vanished
 * while the 87 mA row survived, quietly making every LoRa budget optimistic.
 *
 * A blank-label row is attributed to the nearest labelled row, but only when that
 * label is `MERGE_MARGIN`× nearer than the next-nearest — spacing alone cannot
 * place a row sitting between two labels, and guessing there is how two distinct
 * specs get merged into one. Refusing costs a row; guessing costs the library's
 * trustworthiness, so refusal wins. Measured on the SX1276's two supply-current
 * tables this recovers the rows that matter (TX +20 dBm, the whole RX ladder) and
 * declines the genuinely ambiguous ones.
 *
 * The residual is a row nearer a label it does not belong to — SX1276 p19's
 * `Band 1, BW = 500 kHz` is a receive current sitting one row from the transmit
 * label. Note the direction of that error: a mis-carried row can only add to a
 * mode's worst case, never remove from it, so it can make a budget pessimistic
 * but not optimistic, and it arrives in review with its page and verbatim row
 * text attached for a human to reject.
 *
 * The unit column is carried only for rows that were themselves carried. Units
 * merge the same way, but blank-unit rows are not otherwise evidence of a merge:
 * TPS63020's "Maximum line regulation | 0.5%" has its own label and genuinely
 * has no unit, and inheriting "V" from the row above would fabricate a spec.
 */
export function fillMergedCells(rows: TableRow[], roles: ColumnRoles): TableRow[] {
  // The Mode column merges exactly like a label and for the same reason: Semtech
  // prints "Receive mode" once against the whole RX group, so without carrying it
  // only the row bearing the words is recognisably a receive current.
  const labelCols = [roles.symbol, roles.label, roles.mode].filter(
    (c): c is number => c !== undefined,
  );
  if (labelCols.length === 0) return rows;

  const hasOwnLabel = (row: TableRow): boolean =>
    labelCols.some((c) => textAt(row.cells, c) !== undefined);
  const anchors = rows.map((r, i) => (hasOwnLabel(r) ? i : -1)).filter((i) => i >= 0);
  if (anchors.length === 0) return rows;

  return rows.map((row, i) => {
    if (hasOwnLabel(row)) return row;

    const ranked = anchors
      .map((a) => ({ a, distance: Math.abs(a - i) }))
      .sort((x, y) => x.distance - y.distance);
    const nearest = ranked[0];
    if (nearest === undefined || nearest.distance > MERGE_REACH) return row;
    const runnerUp = ranked[1];
    if (runnerUp !== undefined && runnerUp.distance < MERGE_MARGIN * nearest.distance) return row;
    const best = nearest.a;

    const source = (rows[best] as TableRow).cells;
    const cells = [...row.cells];
    for (const c of labelCols) cells[c] = source[c] ?? "";
    if (roles.unit !== undefined && textAt(cells, roles.unit) === undefined) {
      cells[roles.unit] = source[roles.unit] ?? "";
    }
    return { ...row, cells };
  });
}

// ---- row → typed field ----------------------------------------------------

function ratedRow(cells: string[], roles: ColumnRoles, page: number): ExtractedRatedParam | null {
  const rawUnit = textAt(cells, roles.unit);
  if (rawUnit === undefined) return null; // no unit column → not a rated-param row we can trust
  const unit = normalizeUnit(rawUnit);

  let min = numAt(cells, roles.min);
  let typ = numAt(cells, roles.typ);
  let max = numAt(cells, roles.max);
  const pm = firstPlusMinus(cells, [roles.min, roles.typ, roles.max]);
  if (pm !== null) {
    min = -pm;
    max = pm;
  }
  if (min === null && typ === null && max === null) return null;

  const symbol = textAt(cells, roles.symbol) ?? (roles.label === undefined ? firstTextCell(cells, roles) : undefined);
  const label = textAt(cells, roles.label) ?? symbol ?? firstTextCell(cells, roles);
  if (label === undefined) return null;

  const param = canonicalParam({ symbol, label }) ?? slug(symbol ?? label);
  const conditions = textAt(cells, roles.conditions);
  return {
    param,
    label,
    min,
    typ,
    max,
    unit,
    ...(conditions !== undefined ? { conditions } : {}),
    page,
    snippet: rowSnippet(cells),
    grounding: "verified",
    extractor: "deterministic",
  };
}

function powerRow(cells: string[], roles: ColumnRoles, page: number): ExtractedPowerState | null {
  const unit = currentUnitFor(cells, roles);
  if (unit === undefined) return null;

  const typ = numAt(cells, roles.typ);
  const max = numAt(cells, roles.max);
  if (typ === null && max === null) return null;

  const symbol = textAt(cells, roles.symbol) ?? (roles.label === undefined ? firstTextCell(cells, roles) : undefined);
  const label = textAt(cells, roles.label) ?? symbol;
  const modeText = textAt(cells, roles.mode);
  const conditions = textAt(cells, roles.conditions);
  // A dedicated Mode column is the most direct statement of the state a row
  // measures, so it is read first — ahead of the label and conditions, which
  // name it only incidentally when they name it at all.
  const mode = canonicalPowerState([modeText, label, conditions, symbol].filter(Boolean).join(" "));

  // The name must distinguish this row from its neighbours: one table lists
  // several supply currents whose labels differ only in the conditions column,
  // and naming them all by mode would collapse them into one.
  //
  // Deduplicated because these three can resolve to the same cell — a table with
  // no Parameter column falls back to the symbol for its label, and a row with no
  // symbol falls back again to its first text cell — which otherwise names a row
  // "Configuration retained + RC64k — Configuration retained + RC64k".
  const distinguishing = [...new Set([label, modeText, conditions].filter(Boolean))].join(" — ");
  const name = distinguishing !== "" ? distinguishing : (symbol ?? mode);
  if (name === undefined || name === null) return null;

  return {
    name,
    ...(mode !== null ? { mode } : {}),
    currentTyp: typ,
    currentMax: max,
    unit,
    ...(conditions !== undefined ? { conditions } : {}),
    page,
    snippet: rowSnippet(cells),
    grounding: "verified",
    extractor: "deterministic",
  };
}

function pinRow(cells: string[], roles: ColumnRoles, page: number): ExtractedPin | null {
  const number = textAt(cells, roles.number);
  const name = textAt(cells, roles.name) ?? textAt(cells, roles.symbol) ?? firstTextCell(cells, roles);
  if (name === undefined) return null;

  const description = textAt(cells, roles.fn) ?? textAt(cells, roles.label) ?? "";
  const functions = inferPinFunctions(name, description);
  return {
    name,
    ...(number !== undefined ? { number } : {}),
    functions,
    page,
  };
}

/** Pin function(s) from the name, with the description as a weak secondary signal. */
function inferPinFunctions(name: string, description: string): ExtractedPin["functions"] {
  const byName = pinFunctionByName(name);
  if (byName) return [byName];
  if (/no\s*connect|not\s+connected|reserved|^nc$/i.test(description) || /^nc$/i.test(name)) return ["nc"];
  if (/ground/i.test(description)) return ["ground"];
  if (/supply|power/i.test(description)) return ["supply"];
  return [];
}

function variantRow(headers: string[], cells: string[], page: number): ExtractedVariant | null {
  const filled = cells
    .map((c, i) => ({ text: c.trim(), i }))
    .filter((x) => x.text !== "");
  if (filled.length === 0) return null;

  // the ordering code is the most part-number-shaped cell (letters adjacent to a
  // digit, e.g. STM32F103C8T6), else just the first column
  const mpnLike = filled.filter((x) => /[A-Za-z].*\d|\d.*[A-Za-z]/.test(x.text) && x.text.length >= 4);
  const codeCell = (mpnLike.sort((a, b) => b.text.length - a.text.length)[0] ?? filled[0])!;

  const attrs: Record<string, string> = {};
  for (const { text, i } of filled) {
    if (i === codeCell.i) continue;
    const key = headers[i]?.trim() || `col${i}`;
    attrs[key] = text;
  }
  return { orderingCode: codeCell.text, attrs, page, snippet: rowSnippet(cells) };
}

// ---- table → section partial ---------------------------------------------

export function mapTable(table: ExtractedTable, section: DatasheetSection): SectionExtraction {
  const roles = classifyColumns(table.rawHeaders);
  const out: SectionExtraction = {};

  switch (section) {
    case "pinout": {
      // never fill merged labels here: every pin states its own name, so a blank
      // name is a missing pin, not an inherited one
      out.pins = filterNonNull(table.rows.map((r) => pinRow(r.cells, roles, table.page)));
      break;
    }
    case "ordering": {
      out.variants = filterNonNull(table.rows.map((r) => variantRow(table.headers, r.cells, table.page)));
      break;
    }
    case "absolute-max": {
      const rows = fillMergedCells(table.rows, roles);
      out.absoluteMax = filterNonNull(rows.map((r) => ratedRow(r.cells, roles, table.page)));
      break;
    }
    case "recommended-operating": {
      const rows = fillMergedCells(table.rows, roles);
      out.recommendedOperating = filterNonNull(rows.map((r) => ratedRow(r.cells, roles, table.page)));
      break;
    }
    case "power": {
      const rows = fillMergedCells(table.rows, roles);
      out.powerStates = filterNonNull(rows.map((r) => powerRow(r.cells, roles, table.page)));
      break;
    }
    case "electrical-characteristics": {
      // one table mixes current rows (→ powerStates) with voltage/timing rows
      // (→ recommendedOperating); split them per-row by the unit
      const rec: ExtractedRatedParam[] = [];
      const pwr: ExtractedPowerState[] = [];
      for (const r of fillMergedCells(table.rows, roles)) {
        if (currentUnitFor(r.cells, roles) !== undefined) {
          const ps = powerRow(r.cells, roles, table.page);
          if (ps) {
            pwr.push(ps);
            continue;
          }
        }
        const rr = ratedRow(r.cells, roles, table.page);
        if (rr) rec.push(rr);
      }
      out.recommendedOperating = rec;
      out.powerStates = pwr;
      break;
    }
    default:
      break;
  }
  return out;
}

function filterNonNull<T>(rows: Array<T | null>): T[] {
  return rows.filter((r): r is T => r !== null);
}

function sectionHasRows(part: SectionExtraction): boolean {
  return Boolean(
    (part.absoluteMax && part.absoluteMax.length > 0) ||
      (part.recommendedOperating && part.recommendedOperating.length > 0) ||
      (part.powerStates && part.powerStates.length > 0) ||
      (part.pins && part.pins.length > 0) ||
      (part.interfaces && part.interfaces.length > 0) ||
      (part.variants && part.variants.length > 0),
  );
}
