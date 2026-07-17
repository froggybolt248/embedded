import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { BlockRole } from "@embedded/core";
import { api, type BlockGrounding, type GroundingStatus } from "../../lib/api";
import { ComponentPicker } from "./ComponentPicker";
import { Panel, PanelHeader, StatusDot, EmptyState, type Tone } from "../../components/ui";

/** grounding status → the row's dot + words (the richer, prose version) */
const GROUNDING_UI: Record<GroundingStatus, { tone: Tone; pulse: boolean; label: string; hint: string }> = {
  unbound: { tone: "neutral", pulse: false, label: "", hint: "" },
  grounding: {
    tone: "accent",
    pulse: true,
    label: "grounding…",
    hint: "Reading this part's datasheet for its electrical specs.",
  },
  grounded: {
    tone: "ok",
    pulse: false,
    label: "grounded",
    hint: "Electrical specs read from this part's datasheet.",
  },
  partial: {
    tone: "warn",
    pulse: false,
    label: "no currents",
    hint: "Ratings were read, but no current-consumption table — the rail checks run, the power budget can't count it.",
  },
  ungrounded: { tone: "warn", pulse: false, label: "no specs", hint: "No electrical specs for this part yet." },
  unavailable: {
    tone: "muted",
    pulse: false,
    label: "no datasheet",
    hint: "No machine-readable datasheet — enter its currents by hand, or ingest a PDF.",
  },
  failed: { tone: "danger", pulse: false, label: "no datasheet", hint: "Could not read this part's datasheet." },
};

const anyGrounding = (rows: BlockGrounding[] | undefined): boolean =>
  rows?.some((r) => r.status === "grounding") ?? false;

function RoleBadge({ role }: { role: BlockRole }) {
  return (
    <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-ink-faint">
      {role}
    </span>
  );
}

/** The bound part, by its MPN — the id is a detail the user should never see. */
function BoundPart({ componentId }: { componentId: string }) {
  const { data: component } = useQuery({
    queryKey: ["component", componentId],
    queryFn: () => api.components.get(componentId),
  });
  return (
    <Link
      to="/library/components/$componentId"
      params={{ componentId }}
      className="ring-focus font-mono text-xs text-accent hover:underline"
    >
      {component?.mpn ?? "…"}
    </Link>
  );
}

/**
 * The Components phase: bind each architecture block to a real library part.
 * The block set comes from Architecture; here you choose the part and watch it
 * ground itself against its datasheet. Nothing electrical is derived here — the
 * grounded specs it pulls in feed the Electrical inspector.
 */
export function ComponentsPanel({ projectId, archetypeId }: { projectId: string; archetypeId?: string }) {
  const qc = useQueryClient();
  const [pickingFor, setPickingFor] = useState<string | null>(null);

  const { data: blocks } = useQuery({
    queryKey: ["blocks", projectId],
    queryFn: () => api.blocks.list(projectId),
  });
  const { data: archetype } = useQuery({
    queryKey: ["archetype", archetypeId],
    queryFn: () => api.archetypes.get(archetypeId!),
    enabled: Boolean(archetypeId),
  });
  const hintByName = new Map((archetype?.recipe.suggestedBlocks ?? []).map((b) => [b.name, b.pick]));

  const { data: grounding } = useQuery({
    queryKey: ["grounding", projectId],
    queryFn: () => api.projects.grounding(projectId),
    refetchInterval: (query) => (anyGrounding(query.state.data) ? 800 : false),
  });
  const groundingByBlock = new Map((grounding ?? []).map((g) => [g.blockId, g]));

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["blocks", projectId] });
    qc.invalidateQueries({ queryKey: ["grounding", projectId] });
    qc.invalidateQueries({ queryKey: ["power-budget", projectId] });
    qc.invalidateQueries({ queryKey: ["findings", projectId] });
  };

  const bind = useMutation({
    mutationFn: ({ blockId, componentId }: { blockId: string; componentId: string }) =>
      api.blocks.update(blockId, { componentId }),
    onSuccess: () => {
      setPickingFor(null);
      invalidate();
    },
  });

  const boundCount = (blocks ?? []).filter((b) => b.componentId).length;

  return (
    <Panel>
      <PanelHeader
        title="Components"
        aside={blocks && blocks.length > 0 ? `${boundCount}/${blocks.length} bound` : undefined}
      />

      {blocks?.length === 0 && (
        <EmptyState>Add blocks on the canvas above, then bind a real part to each one here.</EmptyState>
      )}

      <ul>
        {blocks?.map((block) => {
          const state = groundingByBlock.get(block.id);
          const ui = GROUNDING_UI[state?.status ?? (block.componentId ? "grounding" : "unbound")];
          return (
            <li key={block.id} className="border-b border-line/60 px-4 py-3 last:border-b-0">
              <div className="flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-center gap-2">
                  <RoleBadge role={block.role} />
                  <span className="truncate text-sm text-ink">{block.name}</span>
                </div>
                {ui.label && (
                  <span className="flex shrink-0 items-center gap-1.5" title={ui.hint}>
                    <StatusDot tone={ui.tone} pulse={ui.pulse} />
                    <span className="text-[10px] text-ink-faint">{ui.label}</span>
                  </span>
                )}
              </div>

              <div className="mt-1.5 pl-1">
                {block.componentId ? (
                  <div className="flex items-center gap-2">
                    <BoundPart componentId={block.componentId} />
                    <button
                      onClick={() => setPickingFor(block.id)}
                      className="ring-focus text-[11px] text-ink-faint hover:text-ink-dim"
                    >
                      change
                    </button>
                  </div>
                ) : pickingFor !== block.id ? (
                  <button
                    onClick={() => setPickingFor(block.id)}
                    className="ring-focus rounded border border-dashed border-line px-2 py-1 text-[11px] text-ink-faint transition-colors hover:border-accent-dim hover:text-ink-dim"
                  >
                    bind a part
                  </button>
                ) : null}

                {pickingFor === block.id && (
                  <ComponentPicker
                    hint={hintByName.get(block.name)}
                    onPick={(componentId) => bind.mutate({ blockId: block.id, componentId })}
                    onCancel={() => setPickingFor(null)}
                  />
                )}

                {(state?.status === "failed" || state?.status === "unavailable") && (
                  <p className="mt-1.5 text-[11px] text-ink-faint">
                    {state.error ?? "This part has no datasheet link."} — add its currents by hand on the{" "}
                    <Link
                      to="/library/components/$componentId"
                      params={{ componentId: block.componentId! }}
                      className="text-accent hover:underline"
                    >
                      part page
                    </Link>
                    , or ingest the PDF from{" "}
                    <Link to="/library/datasheets" className="text-accent hover:underline">
                      Datasheets
                    </Link>
                    .
                  </p>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}
