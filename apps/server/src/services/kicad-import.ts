import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { CreateComponentInput } from "@embedded/core";
import {
  categoryForLibrary,
  extractSymbols,
  parseSExpr,
  symbolToComponent,
  type KicadSymbol,
} from "@embedded/ingest";
import { createComponentsRepo, type Db } from "@embedded/db";

/**
 * Channel 1 — bulk component acquisition from a cloned KiCad symbol library.
 *
 * The library is the fastest path to breadth: tens of thousands of parts, each
 * already carrying the one thing a datasheet PDF hides in a drawing — its pins
 * — plus a datasheet URL the PDF pipeline (Channel 2) can deepen later. This
 * service walks a clone on disk, maps each symbol to a component, links derived
 * symbols to their base as family variants, and inserts everything, skipping
 * MPNs already in the library so a re-run is idempotent.
 *
 * The clone's on-disk shape (KiCad 9+): one directory `Foo.kicad_symdir` per
 * library, holding one `.kicad_sym` file per symbol, each a self-contained
 * `kicad_symbol_lib`. A derived symbol's `(extends "BASE")` names a sibling in
 * the same library, so family linking is resolved per-directory.
 */

export interface KicadImportProgress {
  stage: "importing";
  detail: string;
  done: number;
  total: number;
  created: number;
}

export interface KicadImportOptions {
  /** only import libraries whose name contains one of these (case-insensitive); default: all */
  libraries?: string[];
  /** stop after this many components created (a quick sample import); default: no cap */
  limit?: number;
  onProgress?: (p: KicadImportProgress) => void;
}

export interface KicadImportSummary {
  librariesProcessed: number;
  symbolsFound: number;
  created: number;
  variantsLinked: number;
  skippedDuplicates: number;
  failedFiles: number;
}

const SYMDIR_SUFFIX = ".kicad_symdir";

/** Library directories under `root`, optionally filtered by name substring. */
function libraryDirs(root: string, filter?: string[]): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && e.name.endsWith(SYMDIR_SUFFIX))
    .map((e) => e.name);
  if (!filter || filter.length === 0) return dirs;
  const needles = filter.map((f) => f.toLowerCase());
  return dirs.filter((d) => needles.some((n) => d.toLowerCase().includes(n)));
}

/** Parse every `.kicad_sym` file in one library directory into symbols. */
function symbolsInLibrary(dir: string): { symbols: KicadSymbol[]; failed: number } {
  const symbols: KicadSymbol[] = [];
  let failed = 0;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".kicad_sym")) continue;
    try {
      const text = readFileSync(join(dir, file), "utf-8");
      symbols.push(...extractSymbols(parseSExpr(text)));
    } catch {
      failed++;
    }
  }
  return { symbols, failed };
}

/**
 * Order symbols so every base precedes the symbols that extend it, so a
 * variant's `familyId` can point at an already-created component. Bases (no
 * `extends`) come first; then derived symbols. A derived symbol whose base is
 * absent from the library is still imported — as a standalone part — rather
 * than dropped.
 */
function basesFirst(symbols: KicadSymbol[]): KicadSymbol[] {
  const bases = symbols.filter((s) => s.extends === undefined);
  const derived = symbols.filter((s) => s.extends !== undefined);
  return [...bases, ...derived];
}

export async function importKicadDirectory(
  db: Db,
  root: string,
  opts: KicadImportOptions = {},
): Promise<KicadImportSummary> {
  const repo = createComponentsRepo(db);
  const summary: KicadImportSummary = {
    librariesProcessed: 0,
    symbolsFound: 0,
    created: 0,
    variantsLinked: 0,
    skippedDuplicates: 0,
    failedFiles: 0,
  };

  // MPNs already present — skip them so re-running the import is idempotent
  const seenMpns = new Set(repo.allMpns());
  // each library is one transaction: without it every insert is its own fsync
  // (an import of tens of thousands of rows crawls); per-library rather than one
  // giant transaction so the loop can yield between libraries and keep the
  // server responsive to the progress endpoint.
  const client = (db as unknown as { $client: { transaction: <T>(fn: () => T) => () => T } }).$client;

  const dirs = libraryDirs(root, opts.libraries);
  for (let i = 0; i < dirs.length; i++) {
    if (opts.limit !== undefined && summary.created >= opts.limit) break;
    const dirName = dirs[i]!;
    client.transaction(() => importLibrary(dirName))();
    opts.onProgress?.({
      stage: "importing",
      detail: basename(dirName, SYMDIR_SUFFIX),
      done: i + 1,
      total: dirs.length,
      created: summary.created,
    });
    // hand the event loop back so a concurrent GET /status is served
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  return summary;

  function importLibrary(dirName: string): void {
    const libraryName = basename(dirName, SYMDIR_SUFFIX);
    const category = categoryForLibrary(libraryName);
    const { symbols, failed } = symbolsInLibrary(join(root, dirName));
    summary.librariesProcessed++;
    summary.symbolsFound += symbols.length;
    summary.failedFiles += failed;

    // component id assigned to each imported symbol name, for extends resolution
    const idByName = new Map<string, { id: string; pins: KicadSymbol["pins"] }>();
    const symbolByName = new Map(symbols.map((s) => [s.name, s]));

    // a variant may name a base imported in THIS run (idByName) or a prior one
    // (the DB) — resolve either so the family link forms across sessions
    const resolveBase = (name: string): { id: string; pins: KicadSymbol["pins"] } | undefined => {
      const inRun = idByName.get(name);
      if (inRun) return inRun;
      const existing = repo.list({ q: name, limit: 25 }).find((c) => c.mpn === name);
      if (!existing) return undefined;
      return { id: existing.id, pins: symbolByName.get(name)?.pins ?? [] };
    };

    for (const symbol of basesFirst(symbols)) {
      if (opts.limit !== undefined && summary.created >= opts.limit) break;

      const input: CreateComponentInput = symbolToComponent(symbol, {
        category,
        ...(symbol.extends !== undefined ? { resolveBase } : {}),
      });

      if (seenMpns.has(input.mpn)) {
        summary.skippedDuplicates++;
        continue;
      }

      const created = repo.create(input);
      seenMpns.add(created.mpn);
      idByName.set(symbol.name, { id: created.id, pins: symbol.pins });
      summary.created++;
      if (input.familyId !== undefined) summary.variantsLinked++;
    }
  }
}
