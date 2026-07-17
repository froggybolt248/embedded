import type { GroundingStatus } from "./schemas.js";

/**
 * Deterministic grounding check for extracted rows.
 *
 * Making `snippet` a required string only ever guaranteed *a* string, never a
 * true one. Observed on a real qwen2.5vl run: a row claiming
 * `tOperating -40/25/85 °C` cited "Note that in I²C mode, even when pressure
 * was not measured, reading the unused registers is faster…" — real text, off
 * the right page, supporting none of those numbers. Four other rows shared one
 * identical filler snippet about filter step response.
 *
 * That is the exact failure this app exists to prevent, and it is the kind of
 * thing no prompt fixes: a model asked for a citation will always produce one.
 * So we check it ourselves. Both checks are pure string work over text we
 * already have — free, offline, and not a matter of opinion:
 *
 *   1. the cited numbers must actually occur in the snippet
 *   2. the snippet must actually occur in the cited page's text layer
 *
 * Check 1 is the discriminating one — a fabricated citation is usually real
 * prose from the right page, so check 2 alone would pass it.
 *
 * A failure is surfaced, never silently dropped: the review UI shows the row
 * with its status so a human decides. The one exception is a row with no
 * values at all, which carries no specification and is dropped as noise.
 */

/** Unicode dash/space variants are everywhere in PDF text layers. */
function normalize(text: string): string {
  return text
    .replace(/[‐-―−]/g, "-")
    .replace(/[   ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Numbers as printed in a datasheet: optional sign, comma-grouped thousands,
 * decimals. Compared numerically rather than textually, so a printed "20,000"
 * still backs a claimed 20000.
 *
 * Whitespace is deliberately NOT accepted as a thousands separator, even though
 * some datasheets print one: table rows set values side by side ("-45 85"), and
 * allowing it merged neighbours into a single bogus number (-4585) — which
 * would have flagged correctly-cited rows as fabricated. Losing "20 000" to a
 * false flag a human then clears beats silently passing a false citation.
 */
const NUMBER = /-?\d+(?:,\d{3})*(?:\.\d+)?/g;

function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of normalize(text).matchAll(NUMBER)) {
    const n = Number(m[0].replace(/,/g, ""));
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

/** Floating-point noise only; NOT a tolerance for "close enough" specs. */
function sameNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= Math.abs(a) * 1e-9 + 1e-9;
}

export function snippetContainsValues(snippet: string, values: Array<number | null>): boolean {
  const present = numbersIn(snippet);
  return values
    .filter((v): v is number => v !== null)
    .every((v) => present.some((p) => sameNumber(p, v)));
}

export function snippetOnPage(snippet: string, pageText: string): boolean {
  return normalize(pageText).includes(normalize(snippet));
}

/**
 * Classify one row against the page it cites. `pageText` absent (an image-only
 * page with no text layer) skips check 2 rather than failing it — a scanned
 * table is a legitimate vision read.
 */
export function checkGrounding(
  row: { snippet: string; page: number },
  values: Array<number | null>,
  pageText: string | undefined,
): GroundingStatus {
  if (!snippetContainsValues(row.snippet, values)) return "value-not-in-snippet";
  if (pageText !== undefined && pageText.trim() !== "" && !snippetOnPage(row.snippet, pageText)) {
    return "snippet-not-on-page";
  }
  return "verified";
}
