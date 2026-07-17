import type {
  Project,
  CreateProjectInput,
  Component,
  CreateComponentInput,
  UpdateComponentInput,
  ComponentCategory,
  Archetype,
  Block,
  BlockRole,
  InterfaceKind,
  CreateBlockInput,
  UpdateBlockInput,
  Connection,
  CreateConnectionInput,
  UpdateConnectionInput,
  Datasheet,
  ExtractionRun,
  Finding,
  PowerMode,
  ValueSource,
  Requirement,
  CreateRequirementInput,
  UpdateRequirementInput,
  QuantifiedRequirement,
} from "@embedded/core";
import type { LlmSettings, LlmProviderKind } from "@embedded/llm";
import type { ExtractionFields } from "@embedded/ingest";

export type { Datasheet, ExtractionRun };

export interface ExtractionRunDetail extends ExtractionRun {
  progress: { phase: string; detail: string } | null;
}

export interface LlmHealthResult {
  provider: LlmProviderKind;
  ok: boolean;
  detail: string;
  latencyMs?: number;
}

export interface LlmExtractTestResult {
  provider: LlmProviderKind;
  ok: boolean;
  model?: string;
  retried?: boolean;
  data?: { part: string; voltage_v: number; interfaces: string[] };
  error?: string;
}

export interface OllamaModelInfo {
  name: string;
  capabilities: string[];
}

export interface LibraryStats {
  total: number;
  byCategory: Record<string, number>;
}

export interface KicadImportSummary {
  librariesProcessed: number;
  symbolsFound: number;
  created: number;
  variantsLinked: number;
  skippedDuplicates: number;
  failedFiles: number;
}

export interface KicadImportJob {
  status: "idle" | "cloning" | "importing" | "done" | "failed";
  detail?: string;
  done?: number;
  total?: number;
  summary?: KicadImportSummary | null;
  error?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
}

export type GroundingStatus =
  | "unbound"
  | "grounding"
  | "grounded"
  /** ratings were read but no current table — grounded for the rail checks, not for the budget */
  | "partial"
  | "ungrounded"
  | "unavailable"
  | "failed";

export interface BlockGrounding {
  blockId: string;
  componentId: string | null;
  status: GroundingStatus;
  detail?: string | null;
  error?: string | null;
}

export interface DutyCycle {
  everySec: number;
  forMs: number;
}

export interface StateContribution {
  mode: PowerMode;
  name: string;
  ma: number;
  duty: DutyCycle;
  fraction: number;
  averageMa: number;
  source?: ValueSource;
}

export interface PowerContribution {
  id: string;
  label: string;
  averageMa: number;
  sharePct: number;
  sleepMa: number;
  sleepSource?: ValueSource;
  sleepFraction: number;
  states: StateContribution[];
  overCommitted: boolean;
}

export interface PowerBudgetResult {
  averageCurrentMa: number;
  batteryLifeHours: number;
  batteryLifeDays: number;
  batteryLifeYears: number;
  contributions: PowerContribution[];
  /** blocks that could not enter the budget — surfaced, never guessed at */
  ungrounded: Array<{ blockId: string; name: string; reason: string }>;
  /** the battery this estimate is about — display, don't re-derive */
  batteryCapacityMah: number;
  /** what that battery is, in words, when the design names one */
  batteryLabel?: string;
  /** the goal to judge against; absent means no verdict is owed */
  targetLifeYears?: number;
}

/** per-block, per-mode duty overrides sent to the budget */
export type DutyOverrides = Record<string, Partial<Record<PowerMode, DutyCycle>>>;

export interface WakeTradeoffOption {
  everySec: number;
  /** human-readable cadence, e.g. "every 10 minutes" — render verbatim, never reformat */
  label: string;
  averageCurrentMa: number;
  batteryLifeYears: number;
  /** null = no target stated; NOT the same as false */
  meetsTarget: boolean | null;
}

export interface WakeTradeoffResult {
  options: WakeTradeoffOption[];
  targetUnreachable: boolean;
  ungrounded: Array<{ blockId: string; name: string; reason: string }>;
  /** the battery these options were actually priced against — display, don't re-derive */
  batteryCapacityMah: number;
  /** what that battery is, in words, when the design names one */
  batteryLabel?: string;
  /** the goal the verdicts were judged against; absent means no verdict was rendered */
  targetLifeYears?: number;
  /** the cadence the designer actually chose; absent means they have not chosen one */
  savedEverySec?: number;
}

export interface WakeProposal {
  everySec: number;
  reason: string;
}

/** A block the assistant proposes; connections reference these by name, not id (ids don't exist yet). */
export interface ProposedBlock {
  name: string;
  role: BlockRole;
  notes?: string;
}
export interface ProposedConnection {
  from: string;
  to: string;
  interface: InterfaceKind;
}
export interface ArchitectureProposal {
  blocks: ProposedBlock[];
  connections: ProposedConnection[];
}

/** one generated firmware file — content is the deliverable, never persisted server-side */
export interface FirmwareFile {
  name: string;
  kind: string;
  content: string;
}

/**
 * What optional external tools the host machine actually has. Every one is
 * false-by-default and no feature hard-requires it — the UI gates affordances
 * on these, never assumes them.
 */
export interface Capabilities {
  probeRs: { present: boolean; version?: string; detail?: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...init,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${body}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** multipart upload — the browser must set its own content-type boundary, so this bypasses request(). */
async function upload<T>(path: string, file: File, fieldName: string): Promise<T> {
  const body = new FormData();
  body.append(fieldName, file);
  const res = await fetch(path, { method: "POST", body });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  return (await res.json()) as T;
}

export const api = {
  projects: {
    list: () => request<Project[]>("/api/projects"),
    get: (id: string) => request<Project>(`/api/projects/${id}`),
    create: (input: CreateProjectInput) =>
      request<Project>("/api/projects", { method: "POST", body: JSON.stringify(input) }),
    remove: (id: string) => request<void>(`/api/projects/${id}`, { method: "DELETE" }),
    grounding: (id: string) => request<BlockGrounding[]>(`/api/projects/${id}/grounding`),
    powerBudget: (
      id: string,
      opts: { batteryCapacityMah?: number; duties: DutyOverrides },
    ) =>
      request<PowerBudgetResult>(`/api/projects/${id}/power-budget`, {
        method: "POST",
        body: JSON.stringify(opts),
      }),
    /**
     * Every option is optional because the SERVER derives them from the design:
     * an archetype states the battery it is built around and the life it is
     * judged against. Send only what the user actively overrode — restating the
     * defaults here would put a second copy of that rule in the view, and two
     * copies of one rule eventually disagree.
     */
    wakeTradeoff: (
      id: string,
      opts: {
        batteryCapacityMah?: number;
        targetLifeYears?: number;
        candidates?: number[];
        duties?: DutyOverrides;
      },
    ) =>
      request<WakeTradeoffResult>(`/api/projects/${id}/wake-tradeoff`, {
        method: "POST",
        body: JSON.stringify(opts),
      }),
    /** commit a cadence — the trade-off's answer becomes the design */
    wakeCadence: (id: string, everySec: number) =>
      request<{ everySec: number; blockIds: string[] }>(`/api/projects/${id}/wake-cadence`, {
        method: "POST",
        body: JSON.stringify({ everySec }),
      }),
    wakeProposal: (id: string) =>
      request<{ proposal: WakeProposal | null }>(`/api/projects/${id}/wake-proposal`, {
        method: "POST",
        body: JSON.stringify({}),
      }),
    /**
     * LLM assist off the critical path: proposes blocks + connections from the
     * project's requirements. null is the normal answer when no provider is
     * configured (or it declined); nothing is created until the user accepts.
     */
    architectureProposal: (id: string) =>
      request<{ proposal: ArchitectureProposal | null }>(
        `/api/projects/${id}/architecture-proposal`,
        { method: "POST", body: JSON.stringify({}) },
      ),
  },
  blocks: {
    list: (projectId: string) => request<Block[]>(`/api/projects/${projectId}/blocks`),
    create: (projectId: string, input: CreateBlockInput) =>
      request<Block>(`/api/projects/${projectId}/blocks`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    update: (id: string, input: UpdateBlockInput) =>
      request<Block>(`/api/blocks/${id}`, { method: "PATCH", body: JSON.stringify(input) }),
    remove: (id: string) => request<void>(`/api/blocks/${id}`, { method: "DELETE" }),
  },
  connections: {
    list: (projectId: string) =>
      request<Connection[]>(`/api/projects/${projectId}/connections`),
    create: (projectId: string, input: CreateConnectionInput) =>
      request<Connection>(`/api/projects/${projectId}/connections`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    update: (id: string, input: UpdateConnectionInput) =>
      request<Connection>(`/api/connections/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    remove: (id: string) => request<void>(`/api/connections/${id}`, { method: "DELETE" }),
  },
  requirements: {
    list: (projectId: string) =>
      request<Requirement[]>(`/api/projects/${projectId}/requirements`),
    create: (projectId: string, input: CreateRequirementInput) =>
      request<Requirement>(`/api/projects/${projectId}/requirements`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    update: (id: string, input: UpdateRequirementInput) =>
      request<Requirement>(`/api/requirements/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    remove: (id: string) => request<void>(`/api/requirements/${id}`, { method: "DELETE" }),
    /**
     * LLM assist off the critical path: null is the normal answer when no
     * provider is configured (or it declined) — never an error, never applied
     * without the user accepting it.
     */
    quantify: (id: string) =>
      request<{ proposal: QuantifiedRequirement | null }>(
        `/api/requirements/${id}/quantify`,
        { method: "POST", body: JSON.stringify({}) },
      ),
  },
  firmware: {
    generate: (projectId: string) =>
      request<{ files: FirmwareFile[] }>(`/api/projects/${projectId}/firmware`),
  },
  capabilities: {
    get: () => request<Capabilities>("/api/capabilities"),
  },
  findings: {
    list: (projectId: string) =>
      request<{ findings: Finding[] }>(`/api/projects/${projectId}/findings`).then(
        (body) => body.findings,
      ),
  },
  components: {
    list: (
      filter: {
        q?: string;
        category?: ComponentCategory;
        familyId?: string;
        mpns?: string[];
        limit?: number;
        offset?: number;
      } = {},
    ) => {
      const params = new URLSearchParams();
      if (filter.q) params.set("q", filter.q);
      if (filter.category) params.set("category", filter.category);
      if (filter.familyId) params.set("familyId", filter.familyId);
      if (filter.mpns?.length) params.set("mpns", filter.mpns.join(","));
      if (filter.limit !== undefined) params.set("limit", String(filter.limit));
      if (filter.offset !== undefined) params.set("offset", String(filter.offset));
      const qs = params.toString();
      return request<Component[]>(`/api/components${qs ? `?${qs}` : ""}`);
    },
    stats: () => request<LibraryStats>("/api/components/stats"),
    get: (id: string) => request<Component>(`/api/components/${id}`),
    create: (input: CreateComponentInput) =>
      request<Component>("/api/components", { method: "POST", body: JSON.stringify(input) }),
    update: (id: string, input: UpdateComponentInput) =>
      request<Component>(`/api/components/${id}`, {
        method: "PATCH",
        body: JSON.stringify(input),
      }),
    remove: (id: string) => request<void>(`/api/components/${id}`, { method: "DELETE" }),
  },
  archetypes: {
    list: () => request<Archetype[]>("/api/archetypes"),
    get: (id: string) => request<Archetype>(`/api/archetypes/${id}`),
  },
  datasheets: {
    list: () => request<Datasheet[]>("/api/datasheets"),
    get: (id: string) => request<Datasheet>(`/api/datasheets/${id}`),
    remove: (id: string) => request<void>(`/api/datasheets/${id}`, { method: "DELETE" }),
    upload: (file: File) => upload<Datasheet>("/api/datasheets", file, "file"),
    extract: (id: string, mode: "hybrid" | "deterministic" = "hybrid") =>
      request<ExtractionRun>(
        `/api/datasheets/${id}/extract${mode === "deterministic" ? "?mode=deterministic" : ""}`,
        { method: "POST", body: JSON.stringify({}) },
      ),
    runs: (id: string) => request<ExtractionRun[]>(`/api/datasheets/${id}/extraction-runs`),
    pageUrl: (id: string, n: number) => `/api/datasheets/${id}/pages/${n}`,
  },
  extractionRuns: {
    get: (id: string) => request<ExtractionRunDetail>(`/api/extraction-runs/${id}`),
    commit: (id: string, body: { fields: ExtractionFields; componentId?: string }) =>
      request<{ component: Component; run: ExtractionRun }>(
        `/api/extraction-runs/${id}/commit`,
        { method: "POST", body: JSON.stringify(body) },
      ),
  },
  kicad: {
    import: (body: { libraries?: string[]; limit?: number; directory?: string } = {}) =>
      request<KicadImportJob>("/api/kicad/import", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    status: () => request<KicadImportJob>("/api/kicad/import/status"),
  },
  llm: {
    getSettings: () => request<LlmSettings>("/api/llm/settings"),
    putSettings: (settings: LlmSettings) =>
      request<LlmSettings>("/api/llm/settings", {
        method: "PUT",
        body: JSON.stringify(settings),
      }),
    health: (provider?: LlmProviderKind) =>
      request<LlmHealthResult>("/api/llm/health", {
        method: "POST",
        body: JSON.stringify(provider ? { provider } : {}),
      }),
    extractTest: (provider?: LlmProviderKind) =>
      request<LlmExtractTestResult>("/api/llm/extract-test", {
        method: "POST",
        body: JSON.stringify(provider ? { provider } : {}),
      }),
    ollamaModels: () =>
      request<{ models: OllamaModelInfo[] }>("/api/llm/ollama/models").then(
        (body) => body.models,
      ),
  },
};
