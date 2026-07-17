import type { PositionedText } from "./pdf.js";

export interface TableRow {
  y: number;
  cells: string[];
}

export interface ExtractedTable {
  page: number;
  /** lower-cased, for matching column roles against a header vocabulary */
  headers: string[];
  /**
   * The header cells as printed. Case is destroyed by `headers` but carries
   * meaning: a unit is often stated only in the column header ("Typ (µA)",
   * "Peak (mA)"), and "µa" is not a unit — looksLikeCurrent needs the real "µA".
   */
  rawHeaders: string[];
  rows: TableRow[];
  columnBands: Array<{ x0: number; x1: number }>;
}

export interface TableOptions {
  rowTolerance?: number;
  minGutter?: number;
  topBandFraction?: number;
  bottomBandFraction?: number;
  /** how many rows a gutter may be spanned by and still count as a gutter */
  spanTolerance?: number;
  /**
   * Page height in points. The top/bottom furniture bands are measured against
   * this when given, and against the topmost text run when not.
   *
   * The fallback is what the fixtures exercise, and it is wrong whenever a page
   * opens with content instead of a running header. SX1262 p16 begins with the
   * heading "3.5.1 Power Consumption" at y=728.7, so a band measured from the
   * text put the cut at 677.7 — just above the power table's own header row at
   * y=681.3. The header was discarded as furniture, and with no header there is
   * no table: the part's entire power section vanished from a page that parses
   * cleanly. Measured against the real 792pt page the cut is 736.6 and the
   * header survives.
   */
  pageHeight?: number;
}

export type CellValue =
  | { kind: "number"; value: number }
  | { kind: "plusminus"; value: number } // plus-minus sign, e.g. "+/-2" -> value 2 (means -2..+2)
  | { kind: "symbolic"; text: string } // e.g. "VDDIO + 0.3" -- not a number
  | { kind: "empty" };

/** One clustered visual row: items sharing (approximately) the same y. */
interface Row {
  y: number;
  items: PositionedText[];
}

type Band = { x0: number; x1: number };

/**
 * Words that mark a table header cell. Deliberately broad and vendor-neutral:
 * heading *chapter* names vary wildly (Atmel "DC Characteristics", TI "ESD
 * Ratings"), but the column header a spec table prints just above its data is
 * drawn from this small shared vocabulary. Matched per-word and by containment,
 * because real header cells are multi-word ("TEST CONDITIONS", "characteristic
 * symbol") and TI writes "NOM" where others write "TYP".
 */
const HEADER_WORDS = new Set([
  "parameter",
  "parameters",
  "symbol",
  "symbols",
  "condition",
  "conditions",
  "test",
  "min",
  "typ",
  "max",
  "nom",
  "nominal",
  "unit",
  "units",
  "remark",
  "remarks",
  "description",
  "name",
  "pin",
  "pins",
  "no",
  "number",
  "function",
  "functions",
  "characteristic",
  "characteristics",
  "rating",
  "ratings",
  // "value"/"values" deliberately excluded: they pair with min/max inside data
  // conditions ("Max value at 85 °C") and split a real table in two. Vendors
  // label the column "typ", not "value".
  "type",
  "item",
  // A power table's states are often named under a "Mode" column rather than a
  // "Symbol" one — deterministic.ts has read a dedicated Mode column since d4,
  // but this vocabulary never learned the word, so the header went unrecognised
  // and the table was never found at all. ESP32-C3 p56/p57 print "Work Mode |
  // Description | Peak (mA)" and "Mode | ... | Description": only "description"
  // is a known word, one distinct word, no header, no table — which is why the
  // part grounded with no current data.
  "mode",
  "modes",
]);

/** The distinct header words present in a string (trailing dots ok). */
function headerWordsIn(text: string, into: Set<string>): void {
  for (const raw of text.toLowerCase().split(/[\s/]+/)) {
    const word = raw.replace(/\.+$/, "");
    if (word !== "" && HEADER_WORDS.has(word)) into.add(word);
  }
}

/**
 * A cell that is only a footnote marker — "(1)", "2)", "*". Requires a paren
 * or asterisk: a bare "2" or "85" is a real value, not a footnote.
 */
const FOOTNOTE_ONLY = /^\(\s*\d+\s*\)$|^\d+\)$|^\*+$/;

// U+00B1 PLUS-MINUS SIGN
const PLUS_MINUS = "±";
// U+2212 MINUS SIGN (distinct from ASCII hyphen-minus)
const UNICODE_MINUS = /−/g;
// U+00A0 NO-BREAK SPACE
const NBSP = / /g;

const PLUS_MINUS_PATTERN = new RegExp(`^${PLUS_MINUS}\\s*([\\d.\\s]+)$`);

/**
 * Cell value parser. A cell is known to hold a single value (unlike free-body
 * text), so space-as-thousands-separator ("20 000") is safe to assume here.
 */
export function parseCell(text: string): CellValue {
  const normalized = text.replace(NBSP, " ").replace(UNICODE_MINUS, "-").trim();
  if (normalized === "") return { kind: "empty" };

  const plusMinusMatch = PLUS_MINUS_PATTERN.exec(normalized);
  if (plusMinusMatch) {
    const numStr = (plusMinusMatch[1] as string).replace(/\s+/g, "");
    const value = Number(numStr);
    if (!Number.isNaN(value) && numStr !== "") return { kind: "plusminus", value };
  }

  const numberMatch = /^([+-])?(\d[\d\s]*)(\.\d+)?$/.exec(normalized);
  if (numberMatch) {
    const sign = numberMatch[1] === "-" ? -1 : 1;
    const intPart = (numberMatch[2] as string).replace(/\s+/g, "");
    const fracPart = numberMatch[3] ?? "";
    const value = sign * Number(intPart + fracPart);
    if (!Number.isNaN(value)) return { kind: "number", value };
  }

  return { kind: "symbolic", text: normalized };
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) return sorted[mid] as number;
  return ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/**
 * Groups items into visual rows: sorted by y descending, clustered by
 * rowTolerance. Body-height items cluster first with the strict tolerance
 * (unchanged from before). Items much shorter than the page's typical text
 * height are super/subscript runs -- e.g. the "2" in "I²C" sits ~3.5pt above
 * its row's baseline in a smaller font, well outside a 3pt rowTolerance --
 * so they're matched separately against the nearest row (body or another
 * script run already placed) within a looser scriptTolerance. A script run
 * that lands near nothing forms its own row, same as any other outlier.
 */
function groupRows(items: PositionedText[], rowTolerance: number, medianHeight: number): Row[] {
  const sorted = [...items].sort((a, b) => b.y - a.y);

  const isScriptRun = (it: PositionedText) => medianHeight > 0 && it.height < 0.8 * medianHeight;
  const bodyItems = sorted.filter((it) => !isScriptRun(it));
  const scriptItems = sorted.filter(isScriptRun);
  const scriptTolerance = 0.6 * medianHeight;

  const rows: Row[] = [];
  for (const it of bodyItems) {
    const last = rows[rows.length - 1];
    // compare against the row's anchor (first/topmost item) rather than the
    // last-added item, so tolerance doesn't drift across a long cluster chain
    if (last && Math.abs(it.y - last.y) <= rowTolerance) {
      last.items.push(it);
    } else {
      rows.push({ y: it.y, items: [it] });
    }
  }

  for (const it of scriptItems) {
    let bestRow: Row | undefined;
    let bestDist = Infinity;
    for (const row of rows) {
      const dist = Math.abs(it.y - row.y);
      if (dist < bestDist) {
        bestDist = dist;
        bestRow = row;
      }
    }
    if (bestRow && bestDist <= scriptTolerance) {
      bestRow.items.push(it);
    } else {
      rows.push({ y: it.y, items: [it] });
    }
  }

  // script runs may have attached to rows out of y-order, or created new
  // rows appended at the end -- restore top-to-bottom order before returning
  rows.sort((a, b) => b.y - a.y);
  for (const row of rows) row.items.sort((a, b) => a.x - b.x);
  return rows;
}

/**
 * A header row carries at least two DISTINCT header words. Distinctness is what
 * separates a header from a data row: "Voltage at any supply pin | VDD and
 * VDDIO pin" repeats "pin" twice (1 distinct → not a header), while a real
 * header names several different columns ("Parameter Condition Min Max Unit" →
 * 5 distinct). Counting repeats instead would misread that data row, and a
 * prose bullet like "…typical values … σ values over lifetime", as tables.
 */
function isHeaderRow(row: Row): boolean {
  const words = new Set<string>();
  for (const it of row.items) headerWordsIn(it.str, words);
  return words.size >= 2;
}

/**
 * Column-band detection by gutter-occupancy voting.
 *
 * Two opposite failure modes rule out any single-pass projection: (1) a wide
 * DATA item — a note ("At T_A = 25 °C, R_L = 10 kΩ …"), a wrapped condition —
 * bridges a gutter the header keeps clear (TI OPA333); (2) a wide HEADER item —
 * "Connect to" spanning three interface sub-columns — bridges a gutter the data
 * keeps clear (BME280 p38 pin table). The unifying signal is occupancy: a real
 * gutter is clear in nearly every row, whichever side the spanning item is on.
 *
 * The tolerance is ABSOLUTE (one spanning item), not a fraction of rows — that
 * distinction is load-bearing. A fraction scaled with row count swallows sparse
 * columns: BME280 p8's Min column is filled in only two rows, and a 12%-of-rows
 * threshold treated that occupancy of 2 as a gutter and merged Min into Typ. An
 * absolute tolerance of 1 keeps the column (2 > 1) while still absorbing the one
 * note per table that would otherwise collapse everything.
 */
function computeColumnBands(rows: Row[], minGutter: number, spanTolerance: number): Band[] {
  const spans = rows.map((r) => r.items.map((it) => ({ x0: it.x, x1: it.x + it.width })));
  const flat = spans.flat();
  if (flat.length === 0) return [];

  const minX = Math.floor(Math.min(...flat.map((s) => s.x0)));
  const maxX = Math.ceil(Math.max(...flat.map((s) => s.x1)));
  const width = maxX - minX + 1;

  const occupancy = new Array(width).fill(0) as number[];
  for (const rowSpans of spans) {
    const covered = new Uint8Array(width);
    for (const s of rowSpans) {
      const a = Math.max(0, Math.floor(s.x0) - minX);
      const b = Math.min(width - 1, Math.ceil(s.x1) - minX);
      for (let i = a; i <= b; i++) covered[i] = 1;
    }
    for (let i = 0; i < width; i++) occupancy[i]! += covered[i]!;
  }

  const bands: Band[] = [];
  let runStart = -1;
  let gutterLen = 0;
  for (let i = 0; i < width; i++) {
    if (occupancy[i]! > spanTolerance) {
      if (runStart === -1) runStart = i;
      gutterLen = 0;
    } else {
      gutterLen++;
      if (runStart !== -1 && gutterLen >= minGutter) {
        bands.push({ x0: minX + runStart, x1: minX + i - gutterLen + 1 });
        runStart = -1;
      }
    }
  }
  if (runStart !== -1) bands.push({ x0: minX + runStart, x1: maxX + 1 });
  return bands;
}

/**
 * A numbered footnote paragraph printed beneath a table: "1. Cold start is
 * equivalent to the device at POR…". It opens with its marker and runs the full
 * width of the table, so it bridges every gutter at once.
 *
 * These are why a table can vanish entirely. Occupancy voting tolerates ONE
 * spanning item per gutter (see computeColumnBands — that tolerance is absolute
 * on purpose and must not be loosened; BME280 p8's Min column has an occupancy
 * of 2 and a laxer threshold merges it into Typ). Semtech prints three footnotes
 * under the SX1262 power table, so every gutter votes 3, no gutter survives, the
 * bands collapse to one, and the whole page is skipped as untabular — taking the
 * part's only current data with it.
 *
 * Excluding them is the honest reading rather than a threshold dodge: a footnote
 * sits BELOW the last data row and is prose about the table, not a row of it. So
 * the table body ends where the footnotes begin.
 */
/**
 * The separator after the marker is OPTIONAL because Espressif prints none:
 * "1 To get better DNL results, you can sample multiple times…" is a footnote
 * with a bare superscript 1, whereas Semtech writes "1. The device is…". The
 * looseness is affordable only because isFootnoteParagraph gates every match on
 * the width test — a bare "100 nF capacitor; DC signal input;" condition cell
 * matches this pattern too, and is saved by being 147pt under a 442pt table.
 */
const FOOTNOTE_PARAGRAPH = /^\(?\d+[.)]?\s+\S|^\*+\s*\S/;

/**
 * The same marker standing alone as its own text run, because it was printed as
 * a superscript and therefore never merged with the prose beside it: Espressif
 * writes "¹ In practice, the current consumption might be different…" under the
 * ESP32-C3 tables, which arrives as a 7pt-wide "1 " item followed by a separate
 * 439pt item. FOOTNOTE_PARAGRAPH cannot see it — there is no dot after the digit
 * and no prose in the same run to match against.
 */
const BARE_FOOTNOTE_MARKER = /^\(?\d+[.)]?$|^\*+$/;

function rowSpan(row: Row): number {
  if (row.items.length === 0) return 0;
  const x0 = Math.min(...row.items.map((it) => it.x));
  const x1 = Math.max(...row.items.map((it) => it.x + it.width));
  return x1 - x0;
}

/**
 * Both conditions are load-bearing. The marker alone would match a data row
 * that happens to open with "1." (an ordering table's line numbering); the
 * width alone would match a table's own header row.
 *
 * The width test measures the WIDEST SINGLE ITEM, not the row's extent. The
 * row's extent is the wrong signal and quietly matches real data: any row with
 * a marker-like first cell and a value in the last column spans the full table
 * ("1. Reset … 9"), and truncating there would silently amputate the table at
 * its first numbered row. One unbroken item spanning the columns is also the
 * exact mechanism by which a footnote bridges the gutters, so this tests the
 * thing that actually does the damage.
 */
function isFootnoteParagraph(row: Row, tableSpan: number): boolean {
  const first = row.items[0];
  if (first === undefined) return false;
  const widestItem = Math.max(...row.items.map((it) => it.width));
  if (widestItem < 0.6 * tableSpan) return false;
  const marker = first.str.trim();
  if (FOOTNOTE_PARAGRAPH.test(marker)) return true;
  // A detached superscript marker (BARE_FOOTNOTE_MARKER) only counts when it is
  // a marker-SHAPED thing: narrow, and followed by the wide run it annotates.
  // The narrowness is what keeps a real wrapped condition — one wide item, no
  // marker beside it — from reading as a footnote, since the two are otherwise
  // the same shape.
  return (
    BARE_FOOTNOTE_MARKER.test(marker) && row.items.length > 1 && first.width < 0.1 * tableSpan
  );
}

/**
 * Trailing material that carries no footnote marker at all: a section heading,
 * the running prose under it, the next table's lead-in. It ends a table for the
 * same reason a footnote does — it is not a row of the table — and it does the
 * same damage, so it is cut by the same mechanism, before the bands are voted on.
 *
 * ESP32-C3 p57 is the case this is measured against. Table 5-9 "Current
 * Consumption in Low-Power Modes" (Light-sleep 130 µA, Deep-sleep 5 µA, Power
 * off 1 µA) has no footnote, so its window ran to the next header row and picked
 * up the "5.7 Memory Specifications" heading and the prose beneath it. Two of
 * those prose lines each bridge every gutter at once, so every gutter votes 2,
 * none survives spanTolerance's 1, the bands collapse to one, and all three data
 * rows are lost with the junk.
 *
 * The signal is the LEFT MARGIN, and it is the only one that survives contact
 * with the real page. A table's rows never start left of its leftmost column;
 * body text starts at the page margin. On p57 the table's left edge is x=80.4
 * and the heading's "5.7" sits at x=56.7, as does every line of prose below it.
 *
 * Width is NOT usable here, however tempting. Table 5-9's own first data row
 * carries a 320.6pt description ("VDD_SPI and Wi-Fi are powered down, and all
 * GPIOs are high-impedance") under a 434.5pt span — 0.74 of the table — so a
 * width cut set low enough to catch prose amputates the table at its first data
 * row. Raising the threshold does not rescue it either: a legitimate wrapped
 * condition can run the FULL table width (see the test that pins this), which is
 * geometrically identical to a footnote paragraph. Only the marker, or the
 * margin, tells them apart. isFootnoteParagraph can use width only because its
 * marker regex carries the proof.
 */
function isOutsideTableFrame(row: Row, headerLeft: number): boolean {
  const first = row.items[0];
  if (first === undefined) return false;
  // items are pre-sorted by x, so the first item is the leftmost
  return first.x < headerLeft - 4;
}

/**
 * A footnote marker printed as a raised superscript, alone on its own row.
 *
 * Espressif raises the marker ~3.6pt above its prose but prints it at the SAME
 * font height (measured on ESP32-C3 p57: every item on the page reports
 * height 10.0, markers included). So groupRows cannot rescue it from either
 * direction — 3.6 is outside the 3pt rowTolerance, and the script-run path that
 * would apply the looser tolerance never fires because the item is not short.
 * The marker lands on a row of its own.
 *
 * Neither row can be judged alone: the marker row is a single 7pt item, and the
 * prose row below it carries no marker at all, which makes it indistinguishable
 * from a legitimate full-width wrapped condition. The PAIR is unambiguous — a
 * bare marker alone on a line, directly above a line of full-width prose, is the
 * top of the footnote block and nothing else.
 *
 * Without this, the three footnotes under ESP32-C3 p57's Modem-sleep table each
 * bridge every gutter, the bands collapse, and the table's CPU currents
 * (23/28/16/21 mA) are lost — the part grounds with a sleep floor and no active
 * draw, which is exactly the "no current data" the user hit.
 */
function isDetachedMarkerRow(row: Row, next: Row | undefined, tableSpan: number): boolean {
  if (next === undefined || row.items.length !== 1) return false;
  const only = row.items[0] as PositionedText;
  if (!BARE_FOOTNOTE_MARKER.test(only.str.trim())) return false;
  if (only.width >= 0.1 * tableSpan) return false;
  return Math.max(...next.items.map((it) => it.width)) >= 0.6 * tableSpan;
}

const SUPERSCRIPT_DIGITS = "⁰¹²³⁴⁵⁶⁷⁸⁹";
const SUBSCRIPT_DIGITS = "₀₁₂₃₄₅₆₇₈₉";

/** A single ASCII digit run rendered as its Unicode super/subscript form, or undefined otherwise. */
function scriptDigit(text: string, superscript: boolean): string | undefined {
  if (!/^[0-9]$/.test(text)) return undefined;
  return (superscript ? SUPERSCRIPT_DIGITS : SUBSCRIPT_DIGITS)[Number(text)];
}

/**
 * Assigns each item to the band containing its center; falls back to the
 * band with the largest span overlap when no band contains the center.
 * Multiple items landing in the same band normally join with a single
 * space, in x order (row.items is pre-sorted by x) -- except a script run
 * (small height, see groupRows) that's touching its neighbor with no real
 * gap is glyph-adjacent text (e.g. "I" + superscript "2" + "C"), not a
 * separate word, so it's fused with no space; a lone digit in that position
 * is additionally rendered as its Unicode super/subscript form using the
 * row's baseline (row.y) to tell superscript from subscript.
 */
function assignCells(row: Row, bands: Band[], medianHeight: number): string[] {
  const GLUE_GAP = 0.75;
  const isScriptRun = (it: PositionedText) => medianHeight > 0 && it.height < 0.8 * medianHeight;

  const cells: string[] = new Array(bands.length).fill("") as string[];
  const lastItemInBand: Array<PositionedText | undefined> = new Array(bands.length).fill(undefined);
  for (const it of row.items) {
    const center = it.x + it.width / 2;
    let idx = bands.findIndex((b) => center >= b.x0 && center <= b.x1);
    if (idx === -1) {
      let bestIdx = -1;
      let bestOverlap = -Infinity;
      const itx0 = it.x;
      const itx1 = it.x + it.width;
      bands.forEach((b, i) => {
        const overlap = Math.min(itx1, b.x1) - Math.max(itx0, b.x0);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          bestIdx = i;
        }
      });
      idx = bestIdx;
    }
    if (idx >= 0) {
      let text = it.str.trim();
      const prev = lastItemInBand[idx];
      let joiner = " ";
      if (prev) {
        const gap = it.x - (prev.x + prev.width);
        if (gap <= GLUE_GAP && (isScriptRun(it) || isScriptRun(prev))) {
          joiner = "";
          if (isScriptRun(it)) {
            const mapped = scriptDigit(text, it.y > row.y + 0.5);
            if (mapped !== undefined) text = mapped;
          }
        }
      }
      cells[idx] = cells[idx] ? `${cells[idx]}${joiner}${text}` : text;
      lastItemInBand[idx] = it;
    }
  }
  return cells;
}

/**
 * A row counts as numeric (blocking continuation-merge) if any of its cells
 * parses as "number" or "plusminus" -- a row bearing a real value (even a
 * plus-minus value) is real table data, not wrapped text from the row above.
 * This is a deliberate broadening of the spec's literal "no cell parsing as
 * a number": treating only kind==="number" as numeric would let a row like
 * PSRR's second line (Condition="", Max="+/-5", Unit="Pa/V") get folded into
 * the row above it, merging two distinct spec rows into one.
 */
function hasNumericCell(cells: string[]): boolean {
  return cells.some((c) => {
    const v = parseCell(c);
    return v.kind === "number" || v.kind === "plusminus";
  });
}

export function extractTables(
  items: PositionedText[],
  page: number,
  opts: TableOptions = {},
): ExtractedTable[] {
  const rowTolerance = opts.rowTolerance ?? 3;
  const minGutter = opts.minGutter ?? 4;
  const topBandFraction = opts.topBandFraction ?? 0.93;
  const bottomBandFraction = opts.bottomBandFraction ?? 0.05;
  const spanTolerance = opts.spanTolerance ?? 1;

  const candidates = items.filter((it) => !it.rotated && it.str.trim() !== "");
  if (candidates.length === 0) return [];
  const frame = opts.pageHeight ?? Math.max(...candidates.map((it) => it.y));
  const filtered = candidates.filter(
    (it) => it.y <= topBandFraction * frame && it.y >= bottomBandFraction * frame,
  );
  if (filtered.length === 0) return [];

  const medianLineHeight = median(filtered.map((it) => it.height));
  const rows = groupRows(filtered, rowTolerance, medianLineHeight);

  const headerIdx: number[] = [];
  rows.forEach((r, i) => {
    if (isHeaderRow(r)) headerIdx.push(i);
  });

  const tables: ExtractedTable[] = [];

  for (let h = 0; h < headerIdx.length; h++) {
    const startIdx = headerIdx[h] as number;
    const endBound = headerIdx[h + 1] ?? rows.length;
    const headerRow = rows[startIdx] as Row;
    let windowRows = rows.slice(startIdx + 1, endBound);
    // Cut the footnote block off before the bands are voted on, not after: an
    // uncut footnote collapses the bands, and a collapsed table never reaches
    // the row loop that would otherwise have dropped it.
    const headerSpan = rowSpan(headerRow);
    const headerLeft = Math.min(...headerRow.items.map((it) => it.x));
    const endAt = windowRows.findIndex(
      (r, i) =>
        isFootnoteParagraph(r, headerSpan) ||
        isOutsideTableFrame(r, headerLeft) ||
        isDetachedMarkerRow(r, windowRows[i + 1], headerSpan),
    );
    if (endAt >= 0) windowRows = windowRows.slice(0, endAt);

    if (windowRows.length === 0) continue;

    // Preliminary bands from the maximal candidate window, used only to
    // decide where the region actually ends.
    const prelimBands = computeColumnBands([headerRow, ...windowRows], minGutter, spanTolerance);
    if (prelimBands.length < 2) continue;

    let prevY = headerRow.y;
    const rawIncluded: Row[] = [];
    for (const row of windowRows) {
      const cells = assignCells(row, prelimBands, medianLineHeight);
      const filledCount = cells.filter((c) => c !== "").length;
      const gap = prevY - row.y;
      const isContinuation =
        filledCount < prelimBands.length / 2 && !hasNumericCell(cells) && gap <= 1.5 * medianLineHeight;
      const isNotTableLike = filledCount === 1 && !isContinuation && gap > 2.5 * medianLineHeight;
      if (isNotTableLike) break;
      rawIncluded.push(row);
      prevY = row.y;
    }
    if (rawIncluded.length === 0) continue;

    // Final bands computed using ONLY the region's actual rows.
    const finalBandsCandidate = computeColumnBands([headerRow, ...rawIncluded], minGutter, spanTolerance);
    const bands = finalBandsCandidate.length >= 2 ? finalBandsCandidate : prelimBands;

    const rawHeaderCells = assignCells(headerRow, bands, medianLineHeight).map((c) => c.trim());
    const headerCells = rawHeaderCells.map((c) => c.toLowerCase());

    const outputRows: TableRow[] = [];
    let prevY2 = headerRow.y;
    for (const row of rawIncluded) {
      const cells = assignCells(row, bands, medianLineHeight);
      const nonEmpty = cells.filter((c) => c !== "");
      const filledCount = nonEmpty.length;
      const gap = prevY2 - row.y;

      // a row whose only content is footnote markers ("(1)") carries no data
      if (filledCount > 0 && nonEmpty.every((c) => FOOTNOTE_ONLY.test(c))) {
        prevY2 = row.y;
        continue;
      }

      // a lone non-numeric cell BEFORE any data row is a group sub-header
      // ("OFFSET VOLTAGE", "INPUT BIAS CURRENT"), not a value — drop it rather
      // than emit a hollow row or merge it into nothing. A lone cell AFTER a
      // data row is a wrapped continuation ("Internal Domains" splitting VDD
      // from VDDIO on BME280 p8) and must merge, so this only fires at the top.
      if (outputRows.length === 0 && filledCount <= 1 && !hasNumericCell(cells)) {
        prevY2 = row.y;
        continue;
      }

      const isContinuation =
        outputRows.length > 0 &&
        filledCount < bands.length / 2 &&
        !hasNumericCell(cells) &&
        gap <= 1.5 * medianLineHeight;
      if (isContinuation) {
        const target = outputRows[outputRows.length - 1] as TableRow;
        for (let ci = 0; ci < bands.length; ci++) {
          const cell = cells[ci] as string;
          if (cell !== "") {
            target.cells[ci] = target.cells[ci] ? `${target.cells[ci]} ${cell}` : cell;
          }
        }
      } else {
        outputRows.push({ y: row.y, cells: [...cells] });
      }
      prevY2 = row.y;
    }

    if (outputRows.length < 2) continue;

    tables.push({
      page,
      headers: headerCells,
      rawHeaders: rawHeaderCells,
      rows: outputRows,
      columnBands: bands,
    });
  }

  return tables;
}
