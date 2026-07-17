import type { LlmProvider } from "@embedded/llm";
import { DatasheetSection } from "@embedded/core";
import { LoadedPdf } from "./pdf.js";
import { extractDeterministic } from "./deterministic.js";
import { PROMPT_VERSION, SECTION_SYSTEM, TRIAGE_SYSTEM, sectionPrompt, triagePrompt } from "./prompts.js";
import { ExtractionFields, SectionExtraction, TriageResult } from "./schemas.js";
import { checkGrounding } from "./verify.js";

export interface IngestProgress {
  stage: "deterministic" | "triage" | "extract";
  detail: string;
  done: number;
  total: number;
}

/**
 * `deterministic`: Tier 0 + Tier 1 only — zero LLM calls, for bulk/zero-cost
 * ingest. `hybrid` (default): run the free path first, then spend the vision
 * model ONLY on the pages it could not cover (image-only pages, odd layouts,
 * decoupling prose) plus one identity-bearing page. On a datasheet with a good
 * outline that is a handful of pages instead of all sixty.
 */
export type ExtractionMode = "deterministic" | "hybrid";

export interface ExtractionOutput {
  sectionMap: Record<string, DatasheetSection>;
  fields: ExtractionFields;
  promptVersion: string;
  models: { triage: string; extraction: string };
}

/** pages per vision request — small batches keep whole tables in one context */
const PAGES_PER_REQUEST = 4;
/** cost guard: total pages sent per section, across all its requests */
const MAX_PAGES_PER_SECTION = 16;
/**
 * Pages per triage request. Classifying a whole datasheet in one call collapses
 * on smaller local models — qwen3:4b put all 60 BME280 pages into just `other`
 * and `pinout`, losing every ratings table — and the prompt can also outgrow a
 * local context window. Batching keeps each call a short, tractable list.
 */
const PAGES_PER_TRIAGE_REQUEST = 12;

const EXTRACTABLE_SECTIONS: DatasheetSection[] = [
  "absolute-max",
  "recommended-operating",
  "electrical-characteristics",
  "power",
  "pinout",
  "application",
  "ordering",
];

/** Section this page will be extracted under, plus the pages behind it. */
function firstPageOfSection(
  sectionMap: Record<string, DatasheetSection>,
  section: DatasheetSection,
): number | undefined {
  const pages = Object.entries(sectionMap)
    .filter(([, s]) => s === section)
    .map(([p]) => Number(p))
    .sort((a, b) => a - b);
  return pages[0];
}

/**
 * Tiered extraction: deterministic first (Tier 0 outline/keyword triage + Tier
 * 1 coordinate table reading, both free), then — in hybrid mode — the vision
 * model on ONLY the residue the free path could not cover. Pure orchestration:
 * no DB, no filesystem; the caller persists the result and renders page PNGs
 * through the passed accessor.
 */
export async function runExtraction(opts: {
  pdf: LoadedPdf;
  /** required in hybrid mode; deterministic mode makes no LLM calls */
  provider?: LlmProvider | undefined;
  /** returns the cached 150-DPI PNG for a page — hybrid mode only */
  pageImage?: ((page: number) => Promise<Buffer>) | undefined;
  onProgress?: (p: IngestProgress) => void;
  mode?: ExtractionMode;
}): Promise<ExtractionOutput> {
  const { pdf, onProgress } = opts;
  const mode = opts.mode ?? "hybrid";

  // ---- Tier 0 + Tier 1: deterministic, no LLM -----------------------------
  const det = await extractDeterministic(pdf, {
    onProgress: (p) => onProgress?.({ stage: "deterministic", detail: p.detail, done: p.done, total: p.total }),
  });
  const merged: ExtractionFields = det.fields;
  const sectionMap: Record<string, DatasheetSection> = { ...det.sectionMap };

  if (mode === "deterministic") {
    return {
      sectionMap,
      fields: merged,
      promptVersion: PROMPT_VERSION,
      models: { triage: `deterministic:${det.triageSource}`, extraction: "none" },
    };
  }

  const { provider, pageImage } = opts;
  if (!provider || !pageImage) {
    throw new Error("hybrid extraction requires `provider` and `pageImage`");
  }

  // Fail before spending on vision if the model is missing/image-blind. Only
  // reached in hybrid mode, and only worth doing when there is residue to send.
  await provider.preflight?.("extraction", { vision: true });

  // ---- LLM triage, but only for pages Tier 0 left unplaced -----------------
  // (empty on the outline path; the keyword path may leave a tail of pages)
  if (det.unclassified.length > 0) {
    const summaries: Array<{ page: number; text: string }> = [];
    for (const p of det.unclassified) summaries.push({ page: p, text: await pdf.pageText(p) });
    for (let i = 0; i < summaries.length; i += PAGES_PER_TRIAGE_REQUEST) {
      const batch = summaries.slice(i, i + PAGES_PER_TRIAGE_REQUEST);
      onProgress?.({
        stage: "triage",
        detail: `classifying pages ${batch[0]?.page}–${batch[batch.length - 1]?.page}`,
        done: i,
        total: summaries.length,
      });
      const triage = await provider.extract("triage", {
        schema: TriageResult,
        schemaName: "datasheet-triage",
        system: TRIAGE_SYSTEM,
        prompt: triagePrompt(batch),
      });
      for (const entry of triage.data.pages) {
        if (batch.some((b) => b.page === entry.page)) sectionMap[String(entry.page)] = entry.section;
      }
    }
    for (const p of det.unclassified) sectionMap[String(p)] ??= "other";
  }

  // ---- vision workset: every extractable page the free path did NOT handle -
  const handled = new Set(det.handledPages);
  const bySection = new Map<DatasheetSection, number[]>();
  const addPage = (section: DatasheetSection, page: number): void => {
    const list = bySection.get(section) ?? [];
    if (!list.includes(page)) list.push(page);
    bySection.set(section, list);
  };
  for (const [pageStr, section] of Object.entries(sectionMap)) {
    if (!EXTRACTABLE_SECTIONS.includes(section)) continue;
    const page = Number(pageStr);
    // a page Tier 1 read tables off is trusted; don't pay to re-read it
    if (handled.has(page)) continue;
    addPage(section, page);
  }

  // The deterministic tier never recovers identity (part number / manufacturer
  // live in the title block, not a spec table). Guarantee it by sending one
  // identity-bearing page — the first abs-max or ordering page carries the ask
  // in its prompt — even if that page was already read for free.
  if (!merged.identity) {
    const idPage =
      firstPageOfSection(sectionMap, "absolute-max") ?? firstPageOfSection(sectionMap, "ordering") ?? 1;
    const idSection: DatasheetSection =
      sectionMap[String(idPage)] === "ordering" ? "ordering" : "absolute-max";
    addPage(idSection, idPage);
  }

  // a section's pages are batched rather than truncated: a long electrical
  // characteristics run would otherwise silently drop its later tables
  const jobs: Array<{ section: DatasheetSection; system: string; pages: number[] }> = [];
  for (const [section, pages] of bySection) {
    const system = SECTION_SYSTEM[section];
    if (!system) continue;
    const chosen = [...pages].sort((a, b) => a - b).slice(0, MAX_PAGES_PER_SECTION);
    for (let i = 0; i < chosen.length; i += PAGES_PER_REQUEST) {
      jobs.push({ section, system, pages: chosen.slice(i, i + PAGES_PER_REQUEST) });
    }
  }

  let done = 0;
  for (const { section, system, pages } of jobs) {
    onProgress?.({
      stage: "extract",
      detail: `extracting ${section} (pages ${pages.join(", ")})`,
      done,
      total: jobs.length,
    });
    const pageInputs = [];
    for (const p of pages) {
      pageInputs.push({
        page: p,
        text: await pdf.pageText(p),
        image: await pageImage(p),
      });
    }

    const result = await provider.extract("extraction", {
      schema: SectionExtraction,
      schemaName: `datasheet-${section}`,
      system,
      prompt: sectionPrompt(section, pageInputs),
      images: pageInputs.map((p) => ({
        mediaType: "image/png" as const,
        dataBase64: p.image.toString("base64"),
      })),
    });
    mergeSection(merged, verifySection(result.data, new Map(pageInputs.map((p) => [p.page, p.text]))));
    done++;
  }

  return {
    sectionMap,
    fields: merged,
    promptVersion: PROMPT_VERSION,
    models: {
      triage: det.unclassified.length > 0 ? provider.modelFor("triage") : `deterministic:${det.triageSource}`,
      extraction: jobs.length > 0 ? provider.modelFor("extraction") : "none",
    },
  };
}

/**
 * Identity of an extracted row, ignoring provenance. Sections overlap (a pin
 * table cited by both `pinout` and `application`, a spec table spanning two
 * batches), so the same row legitimately arrives more than once — merging it
 * blind would multiply every entry by the number of jobs that saw it.
 * Rows that differ in any value or condition are NOT duplicates and survive.
 */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  }
  return value;
}

function signature(row: unknown): string {
  // grounding is derived from snippet, so it varies with provenance and must be
  // excluded alongside it — otherwise one row cited well and cited badly by two
  // jobs would read as two distinct specs.
  const {
    page: _page,
    snippet: _snippet,
    confidence: _confidence,
    grounding: _grounding,
    extractor: _extractor,
    ...rest
  } = row as Record<string, unknown>;
  return JSON.stringify(canonical(rest));
}

function appendUnique<T>(into: T[], incoming: T[] | undefined): void {
  if (!incoming) return;
  const seen = new Set(into.map(signature));
  for (const row of incoming) {
    const key = signature(row);
    if (seen.has(key)) continue;
    seen.add(key);
    into.push(row);
  }
}

/**
 * Score every value-bearing row against the page it cites, and discard rows
 * that state no value at all.
 *
 * Both halves answer things a real run did. Asked for a required `max`, the
 * model padded arrays with rows whose every value was null — a rated parameter
 * with no number is not a partial spec, it is a row about nothing, and five of
 * eleven `recommendedOperating` rows were exactly that. The survivors get a
 * grounding verdict rather than a silent pass, because the model also proved
 * willing to cite prose that supports none of its numbers.
 *
 * Dropping is reserved for rows carrying no information; anything with a value
 * survives and is shown to the reviewer with its verdict attached.
 */
export function verifySection(part: SectionExtraction, pageText: Map<number, string>): SectionExtraction {
  const rate = <T extends { page: number; snippet: string }>(
    rows: T[] | undefined,
    values: (row: T) => Array<number | null>,
    keepValueless = false,
  ): T[] | undefined => {
    if (!rows) return undefined;
    return rows
      .filter((row) => keepValueless || values(row).some((v) => v !== null))
      .map((row) => ({
        ...row,
        grounding: checkGrounding(row, values(row), pageText.get(row.page)),
      }));
  };

  const out: SectionExtraction = { ...part };
  const ratedValues = (r: { min: number | null; typ: number | null; max: number | null }) => [
    r.min,
    r.typ,
    r.max,
  ];
  const absoluteMax = rate(part.absoluteMax, ratedValues);
  const recommendedOperating = rate(part.recommendedOperating, ratedValues);
  const powerStates = rate(part.powerStates, (r) => [r.currentTyp, r.currentMax]);
  // a decoupling note ("100 nF close to VDD") is useful even unquantified
  const decoupling = rate(part.decoupling, (r) => [r.value], true);

  if (absoluteMax) out.absoluteMax = absoluteMax;
  if (recommendedOperating) out.recommendedOperating = recommendedOperating;
  if (powerStates) out.powerStates = powerStates;
  if (decoupling) out.decoupling = decoupling;
  return out;
}

export function mergeSection(into: ExtractionFields, part: SectionExtraction): void {
  if (part.identity && !into.identity) into.identity = part.identity;
  appendUnique(into.variants, part.variants);
  appendUnique(into.absoluteMax, part.absoluteMax);
  appendUnique(into.recommendedOperating, part.recommendedOperating);
  appendUnique(into.powerStates, part.powerStates);
  appendUnique(into.pins, part.pins);
  appendUnique(into.interfaces, part.interfaces);
  appendUnique(into.decoupling, part.decoupling);
}
