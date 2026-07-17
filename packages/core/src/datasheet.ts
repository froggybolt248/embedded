import { z } from "zod";

export const DatasheetSection = z.enum([
  "absolute-max",
  "recommended-operating",
  "electrical-characteristics",
  "power",
  "pinout",
  "package",
  "application",
  /**
   * Ordering / part-number information. Its own section rather than `other`
   * because it is where a family datasheet enumerates its orderable parts —
   * the document's own machine-readable list of the components it describes.
   */
  "ordering",
  "other",
]);
export type DatasheetSection = z.infer<typeof DatasheetSection>;

export const Datasheet = z.object({
  id: z.string(),
  componentId: z.string().nullable().default(null),
  /** original filename for display */
  filename: z.string(),
  /** path under appData/library/datasheets */
  filePath: z.string(),
  sha256: z.string(),
  pageCount: z.number().int().positive(),
  createdAt: z.string(),
});
export type Datasheet = z.infer<typeof Datasheet>;

export const ExtractionStatus = z.enum(["running", "draft", "reviewed", "failed"]);

export const ExtractionRun = z.object({
  id: z.string(),
  datasheetId: z.string(),
  model: z.string(),
  promptVersion: z.string(),
  status: ExtractionStatus,
  /** page → section classification from the triage pass */
  sectionMap: z.record(DatasheetSection).default({}),
  /** raw extracted fields awaiting review, keyed by specs path */
  fields: z.record(z.unknown()).default({}),
  error: z.string().optional(),
  createdAt: z.string(),
});
export type ExtractionRun = z.infer<typeof ExtractionRun>;
