import { DatasheetSection } from "@embedded/core";
import type { OutlineEntry } from "./pdf.js";

/**
 * Tier-0 triage: classify datasheet pages without an LLM.
 *
 * Datasheets are among the most stereotyped documents in engineering — their
 * section headings ("Absolute maximum ratings", "Pin-out", "Electrical
 * characteristics") vary less across vendors than across editions of the same
 * novel. The PDF outline, when present, resolves those headings to exact pages
 * in milliseconds, and it cannot hallucinate: it was authored alongside the
 * document. Measured against this codebase's own history: LLM triage of the
 * BME280 once classified all 60 pages into two buckets; the outline classified
 * all 60 correctly in one free call.
 *
 * The LLM triage pass still exists — demoted to a fallback for the pages this
 * module declines to classify.
 */

export interface DeterministicTriage {
  /** pages this pass is confident about (keys are String(page)) */
  sectionMap: Record<string, DatasheetSection>;
  source: "outline" | "keywords";
  /** pages needing LLM fallback (empty when outline coverage is complete) */
  unclassified: number[];
}

/**
 * Ordered first-match heading rules. Order carries meaning: "Pin-out and
 * connection diagram" must classify as pinout, not application, so pinout
 * precedes the connection-diagram rule.
 */
const HEADING_RULES: Array<{ pattern: RegExp; section: DatasheetSection }> = [
  { pattern: /absolute\s+maximum/i, section: "absolute-max" },
  { pattern: /recommended\s+operating/i, section: "recommended-operating" },
  {
    pattern: /ordering\s+(information|code|guide)|order(ing)?\s+part|part\s+number(ing)?|device\s+(ordering|numbering)|product\s+(selector|selection)|available\s+(part|variant)/i,
    section: "ordering",
  },
  { pattern: /pin\s*-?\s*out|pin\s+(assignment|description|configuration|function)/i, section: "pinout" },
  {
    pattern: /current\s+consumption|power\s+(management|consumption|mode)|current\s+calculation|measurement\s+time/i,
    section: "power",
  },
  {
    pattern: /package\s+(dimension|outline|information|marking)|land(ing)?\s+pattern|tape\s+and\s+reel|solder|marking|mounting|reconditioning|environmental\s+safety|rohs|halogen/i,
    section: "package",
  },
  {
    pattern: /connection\s+diagram|application\s+(circuit|information|hint)|layout|decoupling/i,
    section: "application",
  },
  {
    pattern: /electrical\s+(specification|characteristic)|interface\s+parameter|timings?\b|(^|\W)\d?\.?\s*specification/i,
    section: "electrical-characteristics",
  },
];

function sectionForHeading(title: string): DatasheetSection {
  for (const { pattern, section } of HEADING_RULES) {
    if (pattern.test(title)) return section;
  }
  return "other";
}

/** rank when several sections start on one page: any real section beats other */
const SECTION_PRIORITY: Record<string, number> = {
  "absolute-max": 8,
  "recommended-operating": 7,
  "electrical-characteristics": 6,
  power: 5,
  pinout: 4,
  ordering: 3,
  application: 2,
  package: 1,
  other: 0,
};

/**
 * Classify every page from the PDF outline. Returns null when the outline is
 * missing or too sparse to trust as a page map (a 2-bookmark outline says
 * nothing about page 37) — the caller falls back to text classification.
 */
export function triageFromOutline(
  entries: OutlineEntry[],
  pageCount: number,
): DeterministicTriage | null {
  // density gate: a trustworthy datasheet outline has entries at chapter AND
  // subsection level; ~1 per 10 pages is far below any real one we've seen
  if (entries.length < 3 || entries.length < pageCount * 0.1) return null;

  const ordered = entries
    .filter((e) => e.page >= 1 && e.page <= pageCount)
    .sort((a, b) => a.page - b.page);
  if (ordered.length === 0) return null;

  const sectionMap: Record<string, DatasheetSection> = {};

  for (let i = 0; i < ordered.length; i++) {
    const entry = ordered[i]!;
    const section = sectionForHeading(entry.title);
    // an entry claims its pages up to (not including) the next entry's page;
    // the last entry runs to the end of the document
    const end = i + 1 < ordered.length ? ordered[i + 1]!.page - 1 : pageCount;

    // several entries can start on one page (chapter + its first subsection);
    // the highest-priority section wins the shared page
    const startKey = String(entry.page);
    const existing = sectionMap[startKey];
    if (existing === undefined || SECTION_PRIORITY[section]! > SECTION_PRIORITY[existing]!) {
      sectionMap[startKey] = section;
    }

    for (let p = entry.page + 1; p <= end; p++) {
      sectionMap[String(p)] = section;
    }
  }

  // pages before the first bookmark: cover, TOC, ordering info
  for (let p = 1; p <= pageCount; p++) {
    sectionMap[String(p)] ??= "other";
  }

  return { sectionMap, source: "outline", unclassified: [] };
}

/**
 * Page-text patterns for the no-outline fallback. Stricter than the heading
 * rules: a heading in an outline is authoritative, while a phrase in running
 * text may be a cross-reference ("see Absolute Maximum Ratings on page 13"),
 * so a match only counts near the start of the page, where headings live.
 */
const TEXT_WINDOW = 600;

/**
 * A table of contents names every section in the document, so it matches every
 * heading rule at once and matches them EARLY — measured across 11 vendor
 * datasheets, naive phrase matching put the TOC, not the real ratings table,
 * at 6 of 8 "absolute maximum" hits. Left unhandled the cost compounds: the
 * page is classified as a spec section, yields no table (a TOC has no
 * min/typ/max header), and falls through to the vision model — burning minutes
 * to read a page of dot leaders.
 *
 * Detected by the two things a TOC always has and a spec page never does: a
 * "contents" title, or leader dots running to a page number.
 */
const TOC_TITLE = /^\s*(table\s+of\s+contents|index\s+of\s+contents|contents)\b/i;
/** ". . . . 35" or "......35" — spaced or unspaced, both appear in the corpus */
const LEADER_DOTS = /(\.\s*){4,}\s*\d+/;

function looksLikeToc(head: string): boolean {
  return TOC_TITLE.test(head) || LEADER_DOTS.test(head);
}

/**
 * Classify pages whose opening text carries an unambiguous section heading;
 * everything else is left for the LLM. Deliberately conservative — a wrong
 * confident answer poisons extraction, an unclassified page merely costs one
 * LLM call.
 */
export function triageFromText(
  pages: Array<{ page: number; text: string }>,
): DeterministicTriage {
  const sectionMap: Record<string, DatasheetSection> = {};
  const unclassified: number[] = [];

  for (const { page, text } of pages) {
    const head = text.slice(0, TEXT_WINDOW);
    if (looksLikeToc(head)) {
      // confidently `other` — not merely unclassified, or the LLM would be
      // asked about a page we already know carries no specifications
      sectionMap[String(page)] = "other";
      continue;
    }
    const section = sectionForHeading(head);
    if (section === "other") {
      unclassified.push(page);
    } else {
      sectionMap[String(page)] = section;
    }
  }

  return { sectionMap, source: "keywords", unclassified };
}
