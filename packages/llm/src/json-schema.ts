import type { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

/**
 * Plain (un-$ref'd) JSON Schema for a zod type — the form provider
 * structured-output APIs and prompt embedding both want.
 */
export function toJsonSchema(schema: ZodType<unknown>): Record<string, unknown> {
  return zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
}
