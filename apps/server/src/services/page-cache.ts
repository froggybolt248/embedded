import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appDataDir } from "@embedded/db";
import type { LoadedPdf } from "@embedded/ingest";

/**
 * Shared page-image cache: content-addressed by the datasheet's sha256, so a
 * page rendered once (by the interactive extract route or by auto-grounding's
 * hybrid escalation) is never rendered twice. Pulled out of `routes/datasheets.ts`
 * so `services/deepen.ts` can hand `runExtraction` the identical `pageImage`
 * accessor rather than growing a second renderer with its own cache path.
 */
export function pageCachePath(sha256: string, page: number): string {
  const dir = join(appDataDir(), "library", "pages", sha256);
  mkdirSync(dir, { recursive: true });
  return join(dir, `${page}.png`);
}

/** 150-DPI page PNG, rendered once and cached on disk per datasheet sha. */
export async function renderPageCached(pdf: LoadedPdf, sha256: string, page: number): Promise<Buffer> {
  const file = pageCachePath(sha256, page);
  if (existsSync(file)) return readFileSync(file);
  const rendered = await pdf.renderPage(page);
  writeFileSync(file, rendered.png);
  return rendered.png;
}
