import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RequirementKind, type QuantifiedRequirement, type Requirement } from "@embedded/core";
import { api } from "../../lib/api";

const KINDS: RequirementKind[] = RequirementKind.options;

const STATUSES: Requirement["status"][] = ["open", "met", "at-risk"];

const STATUS_LABEL: Record<Requirement["status"], string> = {
  open: "open",
  met: "met",
  "at-risk": "at risk",
};

const STATUS_CLASS: Record<Requirement["status"], string> = {
  open: "text-ink-faint",
  met: "text-ok",
  "at-risk": "text-warn",
};

/** "open" -> "met" -> "at-risk" -> "open" */
function nextStatus(status: Requirement["status"]): Requirement["status"] {
  const i = STATUSES.indexOf(status);
  return STATUSES[(i + 1) % STATUSES.length]!;
}

const OP_GLYPH: Record<QuantifiedRequirement["op"], string> = {
  "<=": "≤",
  ">=": "≥",
  "==": "=",
  "<": "<",
  ">": ">",
};

/** "avgCurrent ≤ 25 µA" */
function quantifiedLabel(q: QuantifiedRequirement): string {
  return `${q.param} ${OP_GLYPH[q.op]} ${q.value} ${q.unit}`;
}

/**
 * The Scope phase's output — what the thing must do, in the designer's own
 * words, before any of it is machine-checkable. `quantify` is an LLM assist
 * that turns a sentence into a `{param, op, value, unit}` proposal; it is
 * always a proposal, never applied without an explicit Accept, and a null
 * proposal is a normal outcome (no provider configured, or nothing solid to
 * offer) rather than an error to flag red.
 */
export function RequirementsPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<RequirementKind>(KINDS[0]!);
  const [text, setText] = useState("");
  const [proposals, setProposals] = useState<Record<string, QuantifiedRequirement | null>>({});

  const { data: requirements, isLoading } = useQuery({
    queryKey: ["requirements", projectId],
    queryFn: () => api.requirements.list(projectId),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ["requirements", projectId] });

  const add = useMutation({
    mutationFn: () => api.requirements.create(projectId, { text, kind }),
    onSuccess: () => {
      setText("");
      invalidate();
    },
  });

  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Parameters<typeof api.requirements.update>[1] }) =>
      api.requirements.update(id, patch),
    onSuccess: invalidate,
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.requirements.remove(id),
    onSuccess: invalidate,
  });

  const quantify = useMutation({
    mutationFn: (id: string) => api.requirements.quantify(id),
    onSuccess: (result, id) => {
      setProposals((prev) => ({ ...prev, [id]: result.proposal }));
    },
  });

  const clearProposal = (id: string) =>
    setProposals((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });

  return (
    <section className="rounded-lg border border-line bg-surface-1">
      <h2 className="border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        Requirements
      </h2>

      {isLoading && (
        <div className="px-4 py-6 text-center text-xs text-ink-faint">Loading requirements…</div>
      )}

      {requirements && requirements.length === 0 && (
        <p className="px-4 py-6 text-center text-xs text-ink-faint">
          What must this thing do? Write requirements in plain words — numbers can come later.
        </p>
      )}

      {requirements && requirements.length > 0 && (
        <ul>
          {requirements.map((r) => (
            <RequirementRow
              key={r.id}
              requirement={r}
              onRemove={() => remove.mutate(r.id)}
              removing={remove.isPending && remove.variables === r.id}
              onCycleStatus={() =>
                update.mutate({ id: r.id, patch: { status: nextStatus(r.status) } })
              }
              onQuantify={() => {
                clearProposal(r.id);
                quantify.mutate(r.id);
              }}
              quantifying={quantify.isPending && quantify.variables === r.id}
              proposal={proposals[r.id]}
              onAcceptProposal={(proposal) => {
                update.mutate({ id: r.id, patch: { quantified: proposal } });
                clearProposal(r.id);
              }}
              onDismissProposal={() => clearProposal(r.id)}
              onClearQuantified={() => update.mutate({ id: r.id, patch: { quantified: null } })}
            />
          ))}
        </ul>
      )}

      <form
        className="flex flex-wrap gap-2 border-t border-line px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (text.trim()) add.mutate();
        }}
      >
        <select
          value={kind}
          onChange={(e) => setKind(e.target.value as RequirementKind)}
          className="rounded border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink-dim outline-none focus:border-accent-dim"
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <input
          type="text"
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="must sample every 10 minutes…"
          className="min-w-[12rem] flex-1 rounded border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink outline-none focus:border-accent-dim"
        />
        <button
          type="submit"
          disabled={!text.trim() || add.isPending}
          className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 disabled:opacity-40"
        >
          Add
        </button>
      </form>
    </section>
  );
}

function RequirementRow({
  requirement,
  onRemove,
  removing,
  onCycleStatus,
  onQuantify,
  quantifying,
  proposal,
  onAcceptProposal,
  onDismissProposal,
  onClearQuantified,
}: {
  requirement: Requirement;
  onRemove: () => void;
  removing: boolean;
  onCycleStatus: () => void;
  onQuantify: () => void;
  quantifying: boolean;
  /** undefined: no attempt yet this session. null: asked, nothing solid came back. */
  proposal: QuantifiedRequirement | null | undefined;
  onAcceptProposal: (proposal: QuantifiedRequirement) => void;
  onDismissProposal: () => void;
  onClearQuantified: () => void;
}) {
  return (
    <li className="group border-b border-line/60 px-4 py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 text-[10px] uppercase tracking-wide text-ink-faint">
            {requirement.kind}
          </span>
          <span className="truncate text-xs text-ink">{requirement.text}</span>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {requirement.quantified && (
            <span className="num inline-flex items-center gap-1 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-ink-dim">
              {quantifiedLabel(requirement.quantified)}
              <button
                onClick={onClearQuantified}
                className="text-ink-faint hover:text-danger"
                title="remove quantification"
              >
                ×
              </button>
            </span>
          )}
          {!requirement.quantified && !proposal && (
            <button
              onClick={onQuantify}
              disabled={quantifying}
              className="rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:text-ink-dim disabled:opacity-40"
            >
              {quantifying ? "asking…" : "quantify"}
            </button>
          )}
          <button
            onClick={onCycleStatus}
            className={`text-[11px] ${STATUS_CLASS[requirement.status]}`}
          >
            {STATUS_LABEL[requirement.status]}
          </button>
          <button
            onClick={onRemove}
            disabled={removing}
            className="invisible shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:text-danger group-hover:visible disabled:opacity-40"
          >
            remove
          </button>
        </div>
      </div>

      {proposal && (
        <div className="mt-1.5 flex flex-wrap items-center gap-2 border-l border-line pl-2.5">
          <span className="num rounded border border-accent-dim/40 bg-accent/5 px-1.5 py-0.5 text-[10px] text-ink-dim">
            {quantifiedLabel(proposal)}
          </span>
          <button
            onClick={() => onAcceptProposal(proposal)}
            className="text-[11px] text-accent hover:text-accent-dim"
          >
            Accept
          </button>
          <button
            onClick={onDismissProposal}
            className="text-[11px] text-ink-faint hover:text-ink-dim"
          >
            Dismiss
          </button>
        </div>
      )}

      {proposal === null && (
        <p className="mt-1 text-[10px] text-ink-faint">
          no suggestion — the assistant isn't configured or had nothing solid to offer
        </p>
      )}
    </li>
  );
}
