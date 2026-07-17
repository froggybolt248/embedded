import type { GroundingStatus } from "@embedded/ingest";
import type { ExtractionRun } from "../../lib/api";

const STATUS_CLASS: Record<ExtractionRun["status"], string> = {
  running: "bg-accent/15 text-accent",
  draft: "bg-warn/15 text-warn",
  reviewed: "bg-ok/15 text-ok",
  failed: "bg-danger/15 text-danger",
};

export function StatusBadge({ status }: { status: ExtractionRun["status"] }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 font-mono text-[10px] uppercase ${STATUS_CLASS[status]}`}
    >
      {status}
    </span>
  );
}

export function ConfidenceChip({ confidence }: { confidence: number | undefined }) {
  if (confidence === undefined) return <span className="text-xs text-ink-faint">—</span>;
  const low = confidence < 0.8;
  return (
    <span
      className={`num rounded px-1.5 py-0.5 text-[10px] ${
        low ? "bg-warn/15 text-warn" : "bg-surface-3 text-ink-dim"
      }`}
    >
      {Math.round(confidence * 100)}%
    </span>
  );
}

/**
 * The citation's own verdict, from the pipeline's deterministic check — not the
 * model's opinion of itself, which `ConfidenceChip` already shows and which a
 * fabricated citation reports as high.
 */
const GROUNDING: Record<Exclude<GroundingStatus, "verified">, { label: string; title: string }> = {
  "value-not-in-snippet": {
    label: "uncited",
    title: "The snippet does not contain this row's numbers — the citation does not support the value.",
  },
  "snippet-not-on-page": {
    label: "not on page",
    title: "The snippet was not found in the text layer of the page it cites.",
  },
};

export function GroundingChip({ grounding }: { grounding: GroundingStatus | undefined }) {
  if (grounding === undefined || grounding === "verified") return null;
  const { label, title } = GROUNDING[grounding];
  return (
    <span
      title={title}
      className="rounded bg-danger/15 px-1.5 py-0.5 text-[10px] uppercase text-danger"
    >
      {label}
    </span>
  );
}

export function PageChip({ page }: { page: number }) {
  return (
    <span className="num rounded bg-surface-3 px-1.5 py-0.5 text-[10px] text-ink-dim">
      p.{page}
    </span>
  );
}
