import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createComponentsRepo,
  createDatasheetsRepo,
  createExtractionRunsRepo,
  datasheetsDir,
  type Db,
} from "@embedded/db";
import { mergeSpecs, supersedeExtracted, type Component } from "@embedded/core";
import {
  DETERMINISTIC_MODEL,
  LoadedPdf,
  PROMPT_VERSION,
  fieldsToSpecs,
  runExtraction,
} from "@embedded/ingest";
import { resolveDatasheetPdf } from "./datasheet-resolver.js";

/**
 * Channel 1 → Channel 2 bridge: turn a bulk-imported KiCad skeleton into a
 * grounded part, triggered by the act of using it.
 *
 * A KiCad import gives identity, package and pins for 22k parts but nothing
 * electrical — and nothing electrical means no power budget, no rules, no
 * calculators. The missing layer lives in the datasheet whose URL KiCad
 * already recorded. Deepening every part would be enormous and pointless;
 * only the handful bound into a design is worth reading. So binding a part to
 * a block is what triggers this, and the user never asks for it: they plan,
 * and the data arrives.
 *
 * The free deterministic tier does the reading (text-layer tables only, zero
 * LLM calls), which is what makes it safe to fire automatically — no cost, no
 * provider auth, no rate limit standing between the user and their design.
 */

export type GroundingStatus =
  | "grounding"
  | "grounded"
  | "unavailable"
  | "failed";

export interface GroundingState {
  status: GroundingStatus;
  /** short human-readable phase, e.g. "fetching datasheet" */
  detail: string;
  error?: string;
  updatedAt: string;
}

/** in-memory: grounding is re-derivable, and a restart should just retry */
const states = new Map<string, GroundingState>();

function setState(componentId: string, state: Omit<GroundingState, "updatedAt">): void {
  states.set(componentId, { ...state, updatedAt: new Date().toISOString() });
}

export function groundingState(componentId: string): GroundingState | undefined {
  return states.get(componentId);
}

/** A part is grounded once it carries the electrical layer KiCad cannot give. */
export function isGrounded(component: Component): boolean {
  const s = component.specs;
  return s.powerStates.length > 0 || s.absoluteMax.length > 0 || s.recommendedOperating.length > 0;
}

/**
 * The datasheet URL KiCad recorded, from the part or, failing that, its family
 * — variants of a family overwhelmingly share one datasheet, so a variant with
 * a bare attrs map still grounds off the family's PDF.
 */
function datasheetUrl(component: Component, family: Component | undefined): string | undefined {
  const own = component.variantAttrs["datasheet"];
  if (own !== undefined && own !== "" && own !== "~") return own;
  const inherited = family?.variantAttrs["datasheet"];
  if (inherited !== undefined && inherited !== "" && inherited !== "~") return inherited;
  return undefined;
}

/**
 * Vendor datasheet links rot, and the failure needs to be legible to a person
 * rather than a stack trace. Measured across this library's real URLs: most
 * vendors (ST, TI, Microchip, NXP, onsemi, Vishay, Infineon, Nexperia…) serve
 * the PDF to a plain request, but Analog Devices and Maxim answer 403 to any
 * programmatic fetch, some paths 404, some hosts (e.g. Bosch's old
 * ae-bst.resource.bosch.com) no longer resolve at all, and a few (Nordic's
 * infocenter, and — checked live — its docs.nordicsemi.com replacement too)
 * sit behind a Cloudflare bot challenge that a plain fetch can never pass,
 * with or without a User-Agent header. The actual fetching, and the fallback
 * that follows an HTML product page to its real PDF link, live in
 * `./datasheet-resolver.js` — see that file for the ladder and for why a
 * web-search fallback is deliberately NOT part of it.
 */

export interface DeepenResult {
  status: GroundingStatus;
  reason?: string;
}

/**
 * Fetch → extract → merge, updating the grounding state as it goes. Never
 * throws: a part that cannot be grounded is a normal outcome (no URL, dead
 * link, image-only PDF) and must not break the bind that triggered it.
 */
export async function deepenComponent(db: Db, componentId: string): Promise<DeepenResult> {
  const componentsRepo = createComponentsRepo(db);
  const dsRepo = createDatasheetsRepo(db);
  const runsRepo = createExtractionRunsRepo(db);

  const component = componentsRepo.get(componentId);
  if (!component) return { status: "failed", reason: "component not found" };

  // A part read by an OLDER version of this extractor is re-read, because the
  // tier that reads it keeps getting better and the user never asked for the
  // first read either. Without this, every recall fix would only ever reach
  // parts nobody has used yet.
  //
  // The narrowness matters. Only a part this extractor itself produced is
  // re-read: a part grounded by a human, or by a reviewed LLM run, has no
  // deterministic run and is left alone. `mergeSpecs` lets incoming rows
  // override existing ones by key, so re-reading a reviewed part would overwrite
  // human-verified values with unverified machine ones — an auto-refresh must
  // never quietly demote data a person vouched for.
  const existingDatasheet = dsRepo.findByComponent(componentId);
  const priorRuns = existingDatasheet
    ? runsRepo
        .listByDatasheet(existingDatasheet.id)
        .filter((run) => run.model.startsWith("deterministic") && run.status !== "running")
    : [];
  const staleExtractor =
    priorRuns.length > 0 && !priorRuns.some((run) => run.model === DETERMINISTIC_MODEL);
  if (isGrounded(component) && !staleExtractor) {
    setState(componentId, { status: "grounded", detail: "already grounded" });
    return { status: "grounded" };
  }

  const family = component.familyId ? componentsRepo.get(component.familyId) : undefined;
  const url = datasheetUrl(component, family);
  // The PDF on disk is as good as the one on the vendor's server and cannot rot.
  // Re-reading must not depend on a link that worked once and may not now —
  // Bosch retired the host behind every BME/BMP datasheet in this library.
  const cached =
    existingDatasheet !== undefined && existsSync(existingDatasheet.filePath)
      ? existingDatasheet.filePath
      : undefined;
  // A re-read is an improvement, never a requirement: a part that already has
  // data keeps it when the re-read cannot happen. Reporting `unavailable` here
  // would tell the user a part they can see specs for has none.
  if (!url && !cached) {
    if (isGrounded(component)) {
      setState(componentId, { status: "grounded", detail: "already grounded" });
      return { status: "grounded" };
    }
    setState(componentId, { status: "unavailable", detail: "no datasheet URL on this part" });
    return { status: "unavailable", reason: "no datasheet URL" };
  }

  setState(componentId, {
    status: "grounding",
    detail: cached ? "re-reading datasheet" : "fetching datasheet",
  });
  try {
    let bytes: Buffer;
    if (cached) {
      bytes = readFileSync(cached);
    } else {
      const resolved = await resolveDatasheetPdf(url as string, component.mpn);
      // Audit trail for the governing rule ("record WHY, so a human can
      // audit the choice"): there is no DB column for this today, and adding
      // one is out of scope here, so the pick reason goes to the server log
      // rather than being silently dropped.
      console.info(`[deepen] ${componentId} (${component.mpn}): ${resolved.reason} — ${resolved.url}`);
      bytes = resolved.bytes;
    }
    return await groundFromBytes(db, component, bytes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // same invariant: a failed re-read of an already-grounded part is a no-op,
    // not a failure to report — the specs the user can see are still there
    if (isGrounded(component)) {
      setState(componentId, { status: "grounded", detail: "already grounded" });
      return { status: "grounded" };
    }
    setState(componentId, { status: "failed", detail: "grounding failed", error: message });
    return { status: "failed", reason: message };
  }
}

/**
 * Ground a part from PDF bytes, wherever they came from.
 *
 * Split out so a datasheet a PERSON supplied takes the identical path to one the
 * resolver fetched — same deterministic read, same trust rung, same supersede,
 * same content-addressed store. That matters because a hand-dropped PDF is not a
 * lesser fallback, it is the only route that works for a vendor who refuses
 * automated downloads at all: Nordic's nRF52840 sits behind a bot challenge that
 * returns 403 to any plain fetch, with or without a User-Agent, on both the old
 * infocenter URL and its docs.nordicsemi.com replacement. No resolver ladder can
 * ever fix that — but the human clicking "download" in their own browser can, in
 * about ten seconds, and the result is exactly as grounded and as citable.
 *
 * It is still `verified: false`: a human chose the FILE, not the numbers, so the
 * deterministic rows earn `machine` trust and nothing here forges a signature.
 */
export async function groundFromBytes(
  db: Db,
  component: Component,
  bytes: Buffer,
): Promise<DeepenResult> {
  const componentsRepo = createComponentsRepo(db);
  const dsRepo = createDatasheetsRepo(db);
  const runsRepo = createExtractionRunsRepo(db);
  const componentId = component.id;

  const sha256 = createHash("sha256").update(bytes).digest("hex");

  // content-addressed: a family's PDF is stored once no matter how many of its
  // variants get bound, and re-dropping the same file is a no-op
  let datasheet = dsRepo.findBySha(sha256);
  const filePath = join(datasheetsDir(), `${sha256}.pdf`);
  if (!existsSync(filePath)) writeFileSync(filePath, bytes);

  setState(componentId, { status: "grounding", detail: "reading datasheet" });
  const pdf = await LoadedPdf.open(new Uint8Array(bytes));
  try {
    datasheet ??= dsRepo.create({
      componentId,
      filename: `${component.mpn}.pdf`,
      filePath,
      sha256,
      pageCount: pdf.pageCount,
    });

    const run = runsRepo.create({
      datasheetId: datasheet.id,
      model: DETERMINISTIC_MODEL,
      promptVersion: PROMPT_VERSION,
    });

    const output = await runExtraction({ pdf, mode: "deterministic" });
    runsRepo.update(run.id, {
      status: "draft",
      sectionMap: output.sectionMap,
      fields: output.fields as unknown as Record<string, unknown>,
    });

    // `verified: false` is deliberate: nothing here was seen by a human, so
    // only the deterministic (text-layer-copied) rows earn `machine` trust.
    // Auto-grounding must never forge a human signature.
    const incoming = fieldsToSpecs(output.fields, datasheet.id, { verified: false });
    // This read supersedes whatever a previous machine read of this same PDF
    // contributed, rather than piling on top of it: the row names are the
    // extractor's own, they shift as it improves, and merging by name would
    // strand the old rows beside the new ones. Human-verified rows survive.
    const base = supersedeExtracted(component.specs, datasheet.id);
    const merged = mergeSpecs(base, incoming);
    componentsRepo.update(componentId, { specs: merged });
    dsRepo.linkComponent(datasheet.id, componentId);

    const grounded = isGrounded({ ...component, specs: merged });
    if (!grounded) {
      setState(componentId, {
        status: "unavailable",
        detail: "datasheet had no machine-readable spec tables",
      });
      return { status: "unavailable", reason: "no extractable tables" };
    }
    setState(componentId, { status: "grounded", detail: "grounded from datasheet" });
    return { status: "grounded" };
  } finally {
    await pdf.close();
  }
}

/** Fire-and-forget form for the bind path — the state map carries the outcome. */
export function deepenInBackground(db: Db, componentId: string): void {
  if (states.get(componentId)?.status === "grounding") return;
  setState(componentId, { status: "grounding", detail: "queued" });
  void deepenComponent(db, componentId);
}

/** test seam */
export function resetGroundingStates(): void {
  states.clear();
}
