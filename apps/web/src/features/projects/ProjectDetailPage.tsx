import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import type { BlockRole } from "@embedded/core";
import { api, type BlockGrounding, type GroundingStatus } from "../../lib/api";
import { ComponentPicker } from "./ComponentPicker";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { ArchitectureProposal } from "./ArchitectureProposal";
import { BringUpPanel } from "./BringUpPanel";
import { FindingsPanel } from "./FindingsPanel";
import { FirmwarePanel } from "./FirmwarePanel";
import { OptimizePanel } from "./OptimizePanel";
import { PowerBudgetPanel } from "./PowerBudgetPanel";
import { RequirementsPanel } from "./RequirementsPanel";
import { WakeCadencePanel } from "./WakeCadencePanel";

const ROLES: BlockRole[] = ["mcu", "sensor", "radio", "power", "actuator", "display", "other"];

const GROUNDING_UI: Record<GroundingStatus, { dot: string; label: string; hint: string }> = {
  unbound: { dot: "bg-surface-3", label: "", hint: "" },
  grounding: {
    dot: "bg-accent animate-pulse",
    label: "grounding…",
    hint: "Reading this part's datasheet for its electrical specs.",
  },
  grounded: {
    dot: "bg-ok",
    label: "grounded",
    hint: "Electrical specs read from this part's datasheet.",
  },
  partial: {
    dot: "bg-warn",
    label: "no currents",
    hint: "Ratings were read from the datasheet, but no current-consumption table — the rail checks run, the power budget can't count it.",
  },
  ungrounded: { dot: "bg-warn", label: "no specs", hint: "No electrical specs for this part yet." },
  unavailable: {
    dot: "bg-ink-faint",
    label: "no datasheet",
    hint: "No machine-readable datasheet for this part — enter its currents by hand, or ingest a PDF.",
  },
  failed: {
    dot: "bg-danger",
    label: "no datasheet",
    hint: "Could not read this part's datasheet.",
  },
};

/** true while any block is still being grounded — the poll's stop condition */
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
      className="font-mono text-xs text-accent hover:underline"
    >
      {component?.mpn ?? "…"}
    </Link>
  );
}

export function ProjectDetailPage() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const qc = useQueryClient();
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [newRole, setNewRole] = useState<BlockRole>("sensor");
  // null until the designer overrides it — the archetype's battery is the
  // default, so the goal and the estimate start out talking about the same cell
  const [capacityOverride, setCapacityOverride] = useState<number | null>(null);

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.projects.get(projectId),
  });

  // The recipe this project started from — it carries the hint for each block's
  // part search and the power goal the build is judged against.
  const { data: archetype } = useQuery({
    queryKey: ["archetype", project?.archetypeId],
    queryFn: () => api.archetypes.get(project!.archetypeId!),
    enabled: Boolean(project?.archetypeId),
  });
  // joined by name: renaming a block just falls back to a plain search
  const hintByName = new Map(
    (archetype?.recipe.suggestedBlocks ?? []).map((b) => [b.name, b.pick]),
  );
  const { data: blocks } = useQuery({
    queryKey: ["blocks", projectId],
    queryFn: () => api.blocks.list(projectId),
  });

  // While a datasheet is being read, poll; once everything settles, stop. The
  // budget is invalidated alongside so grounded numbers appear on their own.
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
    // findings read the same design — a stale finding about a deleted block
    // reads exactly like a live one
    qc.invalidateQueries({ queryKey: ["findings", projectId] });
  };

  const addBlock = useMutation({
    mutationFn: () => api.blocks.create(projectId, { name: newName.trim(), role: newRole }),
    onSuccess: () => {
      setNewName("");
      invalidate();
    },
  });
  const bind = useMutation({
    mutationFn: ({ blockId, componentId }: { blockId: string; componentId: string }) =>
      api.blocks.update(blockId, { componentId }),
    onSuccess: () => {
      setPickingFor(null);
      invalidate();
    },
  });
  const removeBlock = useMutation({
    mutationFn: (blockId: string) => api.blocks.remove(blockId),
    onSuccess: invalidate,
  });

  // once nothing is in flight, the specs have landed — refresh the numbers
  const stillGrounding = anyGrounding(grounding);
  const [wasGrounding, setWasGrounding] = useState(false);
  if (stillGrounding !== wasGrounding) {
    setWasGrounding(stillGrounding);
    if (!stillGrounding) {
      qc.invalidateQueries({ queryKey: ["power-budget", projectId] });
      // freshly grounded specs feed the rail/abs-max rules too
      qc.invalidateQueries({ queryKey: ["findings", projectId] });
    }
  }

  return (
    <div className="mx-auto max-w-5xl p-8">
      <Link to="/" className="text-xs text-ink-faint hover:text-ink-dim">
        ← Projects
      </Link>
      <h1 className="mt-2 text-xl font-semibold">{project?.name ?? "…"}</h1>
      <p className="mb-6 text-sm text-ink-dim">
        Sketch the architecture, bind real parts, and the electrical numbers follow.
      </p>

      <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
        <div className="flex flex-col gap-4">
        {/* Scope comes before Architecture: what must it do, then what is it */}
        <RequirementsPanel projectId={projectId} />
        <section className="rounded-lg border border-line bg-surface-1">
          <h2 className="border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
            Architecture
          </h2>

          <ul>
            {blocks?.map((block) => {
              const state = groundingByBlock.get(block.id);
              const ui = GROUNDING_UI[state?.status ?? "unbound"];
              return (
                <li key={block.id} className="group border-b border-line/60 px-4 py-3 last:border-b-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-center gap-2">
                      <RoleBadge role={block.role} />
                      <span className="truncate text-sm text-ink">{block.name}</span>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {ui.label && (
                        <span className="flex items-center gap-1.5" title={ui.hint}>
                          <span className={`h-1.5 w-1.5 rounded-full ${ui.dot}`} />
                          <span className="text-[10px] text-ink-faint">{ui.label}</span>
                        </span>
                      )}
                      <button
                        onClick={() => removeBlock.mutate(block.id)}
                        className="invisible rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:text-danger group-hover:visible"
                      >
                        remove
                      </button>
                    </div>
                  </div>

                  {/* why this block exists — seeded from the archetype, and the
                      only teaching the app currently does */}
                  {block.notes !== "" && (
                    <p className="mt-0.5 max-w-lg text-[11px] leading-relaxed text-ink-faint">
                      {block.notes}
                    </p>
                  )}

                  <div className="mt-1.5 pl-1">
                    {block.componentId ? (
                      <div className="flex items-center gap-2">
                        <BoundPart componentId={block.componentId} />
                        <button
                          onClick={() => setPickingFor(block.id)}
                          className="text-[11px] text-ink-faint hover:text-ink-dim"
                        >
                          change
                        </button>
                      </div>
                    ) : pickingFor !== block.id ? (
                      <button
                        onClick={() => setPickingFor(block.id)}
                        className="rounded border border-dashed border-line px-2 py-1 text-[11px] text-ink-faint hover:border-accent-dim hover:text-ink-dim"
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

                    {/* A dead vendor link is a normal outcome, not an error to
                        stare at — say what happened and offer the way forward. */}
                    {(state?.status === "failed" || state?.status === "unavailable") && (
                      <p className="mt-1.5 text-[11px] text-ink-faint">
                        {state.error ?? "This part has no datasheet link."} — add its
                        currents by hand on the{" "}
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

          {blocks?.length === 0 && (
            <p className="px-4 py-6 text-center text-xs text-ink-faint">
              No blocks yet. Start with the MCU, then hang sensors and radios off it.
            </p>
          )}

          <form
            className="flex gap-2 border-t border-line px-4 py-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (newName.trim()) addBlock.mutate();
            }}
          >
            <select
              value={newRole}
              onChange={(e) => setNewRole(e.target.value as BlockRole)}
              className="rounded border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink-dim outline-none focus:border-accent-dim"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Add a block — Environment sensor…"
              className="flex-1 rounded border border-line bg-surface-2 px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint focus:border-accent-dim"
            />
            <button
              type="submit"
              disabled={!newName.trim() || addBlock.isPending}
              className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 disabled:opacity-40"
            >
              Add
            </button>
          </form>

          <ArchitectureProposal projectId={projectId} onApplied={invalidate} />
        </section>

        <FindingsPanel projectId={projectId} />
        </div>

        <div className="flex flex-col gap-4">
          <PowerBudgetPanel
            projectId={projectId}
            capacityOverride={capacityOverride}
            onCapacityChange={setCapacityOverride}
          />
          <WakeCadencePanel projectId={projectId} capacityOverride={capacityOverride} />
          <ConnectionsPanel projectId={projectId} />
          <FirmwarePanel projectId={projectId} />
          <BringUpPanel
            projectId={projectId}
            {...(project?.archetypeId ? { archetypeId: project.archetypeId } : {})}
          />
          <OptimizePanel projectId={projectId} />
        </div>
      </div>
    </div>
  );
}
