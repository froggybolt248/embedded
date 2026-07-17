import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { api } from "../../lib/api";
import { Ring } from "../../components/ui";
import { PHASES, computeProgress, type PhaseId } from "./phases";

/**
 * The project's spine: the seven phases as a vertical progress rail. Each
 * phase shows a completeness ring derived from the design as it actually
 * stands (see `computeProgress`), and clicking one scrolls the workspace to
 * that phase. It replaces the global nav on a project route so the workspace
 * gets three clean panes — the "← Projects" affordance lives here instead.
 *
 * It reads the same query keys the panels do, so the cache is shared: the rail
 * costs no extra network, it just reflects what's already loaded.
 */
export function PhaseRail({
  projectId,
  projectName,
  archetypeName,
  activePhase,
  onSelect,
}: {
  projectId: string;
  projectName: string | undefined;
  archetypeName: string | undefined;
  activePhase: PhaseId;
  onSelect: (id: PhaseId) => void;
}) {
  const { data: requirements } = useQuery({
    queryKey: ["requirements", projectId],
    queryFn: () => api.requirements.list(projectId),
  });
  const { data: blocks } = useQuery({
    queryKey: ["blocks", projectId],
    queryFn: () => api.blocks.list(projectId),
  });
  const { data: connections } = useQuery({
    queryKey: ["connections", projectId],
    queryFn: () => api.connections.list(projectId),
  });
  const { data: grounding } = useQuery({
    queryKey: ["grounding", projectId],
    queryFn: () => api.projects.grounding(projectId),
  });
  const { data: findings } = useQuery({
    queryKey: ["findings", projectId],
    queryFn: () => api.findings.list(projectId),
  });

  const progress = computeProgress({ requirements, blocks, connections, grounding, findings });

  return (
    <nav className="sticky top-0 flex h-screen w-[212px] shrink-0 flex-col border-r border-line bg-surface-1">
      <div className="border-b border-line px-4 pb-3 pt-4">
        <Link
          to="/"
          className="ring-focus inline-flex items-center gap-1.5 text-[11px] text-ink-faint transition-colors hover:text-ink-dim"
        >
          <span aria-hidden>←</span> Projects
        </Link>
        <h1 className="mt-2 truncate text-sm font-semibold text-ink" title={projectName}>
          {projectName ?? "…"}
        </h1>
        {archetypeName && (
          <div className="mt-0.5 truncate text-[11px] text-ink-faint">{archetypeName}</div>
        )}
      </div>

      <ol className="flex flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {PHASES.map((phase, i) => {
          const p = progress[phase.id];
          const active = phase.id === activePhase;
          const done = p.fraction >= 1;
          return (
            <li key={phase.id}>
              <button
                type="button"
                onClick={() => onSelect(phase.id)}
                aria-current={active ? "step" : undefined}
                className={`ring-focus group relative flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left transition-colors ${
                  active ? "bg-surface-2" : "hover:bg-surface-2/60"
                }`}
              >
                {active && (
                  <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                )}
                <Ring value={p.fraction} tone={p.tone} size={22}>
                  {done ? <span className="text-ok">✓</span> : i + 1}
                </Ring>
                <span className="min-w-0">
                  <span
                    className={`block truncate text-xs transition-colors ${
                      active ? "text-ink" : "text-ink-dim group-hover:text-ink"
                    }`}
                  >
                    {phase.label}
                  </span>
                  <span className="block truncate text-[10px] text-ink-faint">{phase.blurb}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="border-t border-line px-4 py-2.5 font-mono text-[10px] text-ink-faint">
        local · all data yours
      </div>
    </nav>
  );
}
