import type { ZodType, ZodTypeDef } from "zod";

/**
 * Per-task model tiers. Tasks pick a tier, settings map tiers to concrete
 * models per provider — so "use the cheap model for triage" is one config
 * edit, not a code change.
 */
export type ModelTier = "triage" | "extraction" | "assistant";
export const MODEL_TIERS: readonly ModelTier[] = ["triage", "extraction", "assistant"];

export type LlmProviderKind = "claude-code" | "openai-compat" | "ollama";

export interface LlmImage {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  dataBase64: string;
}

export interface LlmUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export interface ExtractRequest<T> {
  /** input type is free so schemas with .default()s infer T from their OUTPUT */
  schema: ZodType<T, ZodTypeDef, unknown>;
  /** stable name for the schema — used for provider schema naming + logs */
  schemaName: string;
  system?: string;
  prompt: string;
  images?: LlmImage[];
}

export interface ExtractResult<T> {
  data: T;
  model: string;
  /** raw model output, kept for audit trails (ExtractionRun.fields provenance) */
  raw: string;
  usage?: LlmUsage;
  /** true when the first response failed schema validation and a retry fixed it */
  retried: boolean;
}

export interface StreamRequest {
  system?: string;
  prompt: string;
  images?: LlmImage[];
}

export type StreamEvent =
  | { type: "text"; text: string }
  | { type: "done"; model: string; usage?: LlmUsage };

export interface LlmCapabilities {
  vision: boolean;
  /** native = provider-enforced JSON schema; prompted = schema embedded in prompt, zod-validated */
  structuredOutput: "native" | "prompted";
}

export interface ProviderHealth {
  ok: boolean;
  /** human-readable status: model/version info, or the error + a fix hint */
  detail: string;
  latencyMs?: number;
}

export interface LlmProvider {
  readonly kind: LlmProviderKind;
  modelFor(tier: ModelTier): string;
  capabilities(): LlmCapabilities;
  extract<T>(tier: ModelTier, req: ExtractRequest<T>): Promise<ExtractResult<T>>;
  stream(tier: ModelTier, req: StreamRequest): AsyncIterable<StreamEvent>;
  /** reachability/auth check; may issue one tiny generation */
  health(): Promise<ProviderHealth>;
  /**
   * Optional: throw if this tier cannot satisfy `need`, BEFORE the caller
   * spends anything. Lets a long pipeline fail in milliseconds on a model that
   * isn't installed or can't see images, instead of after its triage pass.
   * Providers that can't know cheaply simply omit it.
   */
  preflight?(tier: ModelTier, need: { vision?: boolean }): Promise<void>;
}

export class LlmError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "LlmError";
    if (cause !== undefined) this.cause = cause;
  }
}
