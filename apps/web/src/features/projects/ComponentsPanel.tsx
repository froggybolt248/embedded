import { useRef, useState } from "react";
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
    label: "no current data",
    hint: "Ratings were read, but the datasheet had no current table — the power budget can't count this part.",
  },
  ungrounded: { tone: "warn", pulse: false, label: "no specs", hint: "No electrical specs for this part yet." },
  unavailable: {
    tone: "muted",
    pulse: false,
    label: "no datasheet",
    hint: "This part has no datasheet link.",
  },
  failed: {
    tone: "danger",
    pulse: false,
    label: "fetch blocked",
    hint: "The datasheet could not be downloaded — many vendor sites block automated fetches.",
  },
};

/** every stuck state gets a way forward, phrased for that state */
const RECOVERY_LEAD: Partial<Record<GroundingStatus, string>> = {
  failed: "The vendor's site refused the download.",
  unavailable: "This part has no datasheet link.",
  partial: "The datasheet had no current-consumption table.",
  ungrounded: "No electrical specs yet.",
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
                    role={block.role}
                    onPick={(componentId) => bind.mutate({ blockId: block.id, componentId })}
                    onCancel={() => setPickingFor(null)}
                  />
                )}

                {block.componentId && state?.status && RECOVERY_LEAD[state.status] && (
                  <GroundingRecovery
                    componentId={block.componentId}
                    lead={state.error ?? RECOVERY_LEAD[state.status]!}
                    onPickDifferent={() => setPickingFor(block.id)}
                    onGrounded={invalidate}
                  />
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/**
 * A stuck grounding state, with its ways forward — right here, not three
 * screens away. The strongest action is the one-step PDF drop: the user
 * downloads the datasheet in their own browser (which vendor sites allow) and
 * drops it on the button; the part grounds through the normal pipeline.
 */
function GroundingRecovery({
  componentId,
  lead,
  onPickDifferent,
  onGrounded,
}: {
  componentId: string;
  lead: string;
  onPickDifferent: () => void;
  onGrounded: () => void;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const upload = useMutation({
    mutationFn: (file: File) => api.components.uploadDatasheet(componentId, file),
    onSuccess: onGrounded,
  });

  return (
    <div className="mt-1.5 text-[11px] text-ink-faint">
      <p>{lead}</p>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,application/pdf"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) upload.mutate(f);
            e.target.value = "";
          }}
        />
        <button
          onClick={() => fileRef.current?.click()}
          disabled={upload.isPending}
          className="text-accent hover:underline disabled:opacity-50"
        >
          {upload.isPending ? "reading PDF…" : "Upload its datasheet PDF"}
        </button>
        <Link
          to="/library/components/$componentId"
          params={{ componentId }}
          className="text-accent hover:underline"
        >
          Enter currents by hand
        </Link>
        <button onClick={onPickDifferent} className="text-accent hover:underline">
          Pick a different part
        </button>
      </div>
      {upload.isError && (
        <p className="mt-1 text-danger">
          {upload.error instanceof Error ? upload.error.message : "upload failed"}
        </p>
      )}
      {upload.isSuccess && upload.data.status !== "grounded" && (
        <p className="mt-1 text-warn">
          PDF read, but no usable spec tables found{upload.data.reason ? ` — ${upload.data.reason}` : ""}.
          Enter the currents by hand instead.
        </p>
      )}
    </div>
  );
}
