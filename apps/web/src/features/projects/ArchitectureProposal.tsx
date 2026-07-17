import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, type ArchitectureProposal as Proposal } from "../../lib/api";

/**
 * The Architecture-phase LLM assist: "propose the blocks and wiring from what
 * this project must do." It is always a PROPOSAL — nothing is added to the
 * design until the user accepts it — and a null proposal (no provider, or the
 * assistant declined) is a normal quiet outcome, never an error to flag red.
 *
 * Applying is deliberately all-or-nothing per accept: blocks are created
 * first, then only the connections whose both endpoints exist get wired, so a
 * proposal that names a block it never listed can never mint a dangling wire.
 * The proposal references blocks by name because none of them have ids yet.
 */
export function ArchitectureProposal({
  projectId,
  onApplied,
}: {
  projectId: string;
  onApplied: () => void;
}) {
  const qc = useQueryClient();
  // undefined: not asked yet. null: asked, nothing solid came back. object: a live proposal.
  const [proposal, setProposal] = useState<Proposal | null | undefined>(undefined);

  const ask = useMutation({
    mutationFn: () => api.projects.architectureProposal(projectId),
    onSuccess: (res) => setProposal(res.proposal),
  });

  const apply = useMutation({
    mutationFn: async (p: Proposal) => {
      // Create the blocks first and remember each one's new id by the name the
      // proposal used, so the connections can resolve their endpoints.
      const idByName = new Map<string, string>();
      for (const b of p.blocks) {
        const created = await api.blocks.create(projectId, {
          name: b.name,
          role: b.role,
          ...(b.notes !== undefined ? { notes: b.notes } : {}),
        });
        idByName.set(b.name, created.id);
      }
      for (const c of p.connections) {
        const from = idByName.get(c.from);
        const to = idByName.get(c.to);
        if (!from || !to || from === to) continue;
        await api.connections.create(projectId, {
          fromBlockId: from,
          toBlockId: to,
          interface: c.interface,
        });
      }
    },
    onSuccess: () => {
      setProposal(undefined);
      qc.invalidateQueries({ queryKey: ["blocks", projectId] });
      qc.invalidateQueries({ queryKey: ["connections", projectId] });
      qc.invalidateQueries({ queryKey: ["findings", projectId] });
      onApplied();
    },
  });

  return (
    <div className="border-t border-line px-4 py-3">
      {proposal == null && (
        <div className="flex items-center justify-between gap-3">
          <span className="text-[11px] text-ink-faint">
            Not sure where to start? Let the assistant sketch the blocks and wiring from your
            requirements.
          </span>
          <button
            type="button"
            onClick={() => ask.mutate()}
            disabled={ask.isPending}
            className="shrink-0 rounded border border-line px-3 py-1.5 text-xs font-medium text-ink-dim hover:text-ink disabled:opacity-40"
          >
            {ask.isPending ? "thinking…" : "Propose from requirements"}
          </button>
        </div>
      )}

      {proposal === null && (
        <p className="mt-1 text-[10px] text-ink-faint">
          no proposal — the assistant isn't configured or had nothing solid to offer
        </p>
      )}

      {proposal && (
        <div className="rounded border border-accent-dim/40 bg-accent/5 p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-[11px] font-medium text-ink-dim">Proposed architecture</span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => apply.mutate(proposal)}
                disabled={apply.isPending}
                className="rounded bg-accent px-3 py-1 text-[11px] font-medium text-surface-0 disabled:opacity-40"
              >
                {apply.isPending ? "adding…" : "Add all to design"}
              </button>
              <button
                type="button"
                onClick={() => setProposal(undefined)}
                className="text-[11px] text-ink-faint hover:text-ink-dim"
              >
                Dismiss
              </button>
            </div>
          </div>

          <ul className="space-y-1">
            {proposal.blocks.map((b) => (
              <li key={b.name} className="flex items-baseline gap-2 text-[11px]">
                <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-ink-faint">
                  {b.role}
                </span>
                <span className="text-ink-dim">{b.name}</span>
              </li>
            ))}
          </ul>

          {proposal.connections.length > 0 && (
            <ul className="mt-2 space-y-0.5 border-t border-line/60 pt-2">
              {proposal.connections.map((c, i) => (
                <li key={i} className="num text-[10px] text-ink-faint">
                  {c.from} → {c.to} <span className="uppercase">({c.interface})</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
