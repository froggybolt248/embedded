import { createCanvas } from "@napi-rs/canvas";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist/types/src/display/api.js";

/** PDF points are 72/inch; scale = dpi/72. 150 DPI is plenty for vision models. */
const DEFAULT_DPI = 150;

export interface RenderedPage {
  pageNumber: number;
  png: Buffer;
  width: number;
  height: number;
}

/** One flattened PDF-outline (bookmark) entry, resolved to its 1-based page. */
export interface OutlineEntry {
  title: string;
  page: number;
  /** nesting level, 0 = top; "2. Absolute maximum ratings" vs "6.4.2 I²C timings" */
  depth: number;
}

/**
 * One positioned text run — the raw material for deterministic table
 * extraction. Coordinates are PDF points with the origin at the page's
 * bottom-left (y grows upward), exactly as pdfjs reports them.
 */
export interface PositionedText {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  /** true for rotated runs (vertical table headers); most consumers skip them */
  rotated: boolean;
}

/**
 * Whether a page carries a text layer worth reading deterministically.
 *
 * This is the gate that keeps the slow path rare. A born-digital datasheet
 * page yields dozens to hundreds of positioned runs; a scanned or
 * image-only page yields nearly none, and only that case genuinely needs a
 * vision model. Note the question is narrow — a page CAN have a rich text
 * layer and still hold no table (BME280 p38 is a package drawing with 112
 * runs of labels), so a failed table extraction is a separate signal.
 *
 * The threshold is deliberately low: the cost of wrongly sending a sparse
 * page down the deterministic path is one empty result, while wrongly
 * sending a readable page to vision costs minutes.
 */
/**
 * Adobe Symbol font glyphs, keyed by their Symbol character position.
 *
 * A PDF using the Symbol font with no ToUnicode table leaves pdfjs nothing to
 * decode with, so it passes the raw code through in the Private Use Area as
 * U+F000 + position. Semtech's SX1262 datasheet prints the µ of "µA" exactly
 * this way (U+F06D — Symbol position 0x6D, where a text font would have 'm').
 *
 * Left undecoded the run is a PUA character, so "1.2 µA" arrives as " A",
 * no unit matches, and the row is dropped — the part's warm-start sleep current
 * silently vanishes from every budget. Worse, a unit parser lenient enough to
 * ignore the unknown glyph reads it as "A": 1.2 A, a millionfold overstatement.
 *
 * This is a lookup, not a guess: Symbol's encoding is fixed and published, so
 * the mapping is as deterministic as any other font's ToUnicode would be.
 * Restricted to the glyphs that carry meaning in a spec table — Greek letters
 * used as prefixes/quantities and the comparison and tolerance signs. An
 * unlisted code is left alone rather than guessed at, which keeps a
 * non-Symbol font's PUA use (Wingdings and friends) from being mistranslated.
 */
const SYMBOL_PUA: ReadonlyMap<number, string> = new Map([
  [0x44, "Δ"],
  [0x57, "Ω"],
  [0x61, "α"],
  [0x62, "β"],
  [0x64, "δ"],
  [0x65, "ε"],
  [0x67, "γ"],
  [0x6c, "λ"],
  [0x6d, "µ"],
  [0x6e, "ν"],
  [0x70, "π"],
  [0x72, "ρ"],
  [0x73, "σ"],
  [0x74, "τ"],
  [0x77, "ω"],
  [0xa3, "≤"],
  [0xb0, "°"],
  [0xb1, "±"],
  [0xb3, "≥"],
  [0xb4, "×"],
  [0xb7, "·"],
  [0xb9, "≠"],
  [0xf7, "÷"],
]);

const SYMBOL_PUA_RANGE = /[-]/g;

/** Decodes Symbol-font glyphs pdfjs left in the Private Use Area. */
export function decodeSymbolPua(str: string): string {
  if (!SYMBOL_PUA_RANGE.test(str)) {
    SYMBOL_PUA_RANGE.lastIndex = 0;
    return str;
  }
  SYMBOL_PUA_RANGE.lastIndex = 0;
  return str.replace(SYMBOL_PUA_RANGE, (ch) => {
    const mapped = SYMBOL_PUA.get((ch.codePointAt(0) as number) - 0xf000);
    return mapped ?? ch;
  });
}

export function hasUsableTextLayer(items: PositionedText[], minRuns = 8): boolean {
  return items.length >= minRuns;
}

/**
 * A loaded datasheet PDF. Wraps pdfjs so the rest of the pipeline never
 * touches pdfjs types — render pages to PNG for vision extraction, pull the
 * text layer for grounding snippets.
 */
export class LoadedPdf {
  private constructor(
    private readonly doc: PDFDocumentProxy,
    private readonly destroyFn: () => Promise<unknown>,
  ) {}

  static async open(data: Uint8Array): Promise<LoadedPdf> {
    const task = getDocument({
      data,
      // no worker in Node — run inline
      useWorkerFetch: false,
    });
    const doc = await task.promise;
    return new LoadedPdf(doc, () => task.destroy());
  }

  get pageCount(): number {
    return this.doc.numPages;
  }

  async renderPage(pageNumber: number, dpi: number = DEFAULT_DPI): Promise<RenderedPage> {
    const page = await this.doc.getPage(pageNumber);
    const viewport = page.getViewport({ scale: dpi / 72 });
    const width = Math.ceil(viewport.width);
    const height = Math.ceil(viewport.height);
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    // @napi-rs/canvas context is API-compatible with the DOM 2D context,
    // but the tsconfig has no DOM lib — hence the cast
    await page.render({
      canvasContext: ctx,
      canvas: null,
      viewport,
    } as unknown as Parameters<typeof page.render>[0]).promise;
    return { pageNumber, png: canvas.toBuffer("image/png"), width, height };
  }

  /**
   * The document outline (bookmarks), flattened and resolved to page numbers.
   * Returns [] when the PDF ships no outline — a normal case, not an error;
   * callers fall back to text-based classification. Entries whose destination
   * cannot be resolved are skipped rather than failing the whole outline.
   */
  async outline(): Promise<OutlineEntry[]> {
    const root = await this.doc.getOutline();
    if (!root) return [];
    const out: OutlineEntry[] = [];
    const walk = async (items: NonNullable<typeof root>, depth: number): Promise<void> => {
      for (const item of items) {
        try {
          const dest =
            typeof item.dest === "string" ? await this.doc.getDestination(item.dest) : item.dest;
          const ref = Array.isArray(dest) ? dest[0] : undefined;
          if (ref) {
            out.push({
              title: item.title.replace(/\s+/g, " ").trim(),
              page: (await this.doc.getPageIndex(ref)) + 1,
              depth,
            });
          }
        } catch {
          // unresolvable destination — skip this entry, keep the rest
        }
        if (item.items?.length) await walk(item.items, depth + 1);
      }
    };
    await walk(root, 0);
    return out;
  }

  /**
   * Page height in PDF points — the frame a running header or footer is placed
   * against, and so the only sound reference for "is this run page furniture".
   * The topmost text on a page is not: a page whose first line is a section
   * heading rather than a running header has no furniture at all up there.
   */
  async pageHeight(pageNumber: number): Promise<number> {
    const page = await this.doc.getPage(pageNumber);
    return page.getViewport({ scale: 1 }).height;
  }

  /** Positioned text runs of one page, for coordinate-based table extraction. */
  async pageItems(pageNumber: number): Promise<PositionedText[]> {
    const page = await this.doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const out: PositionedText[] = [];
    for (const item of content.items) {
      if (!("str" in item) || item.str.trim() === "") continue;
      const [a, b, , , x, y] = item.transform as number[];
      out.push({
        str: decodeSymbolPua(item.str),
        x: x ?? 0,
        y: y ?? 0,
        width: item.width,
        height: item.height,
        rotated: Math.abs(Math.atan2(b ?? 0, a ?? 1)) > 0.01,
      });
    }
    return out;
  }

  /** Text-layer content of one page, reading-order joined. */
  async pageText(pageNumber: number): Promise<string> {
    const page = await this.doc.getPage(pageNumber);
    const content = await page.getTextContent();
    return content.items
      .map((item) => ("str" in item ? decodeSymbolPua(item.str) : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
  }

  async close(): Promise<void> {
    await this.destroyFn();
  }
}
