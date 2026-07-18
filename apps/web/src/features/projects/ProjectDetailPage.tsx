import { useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api } from "../../lib/api";
import { Button, Panel, PanelHeader } from "../../components/ui";
import { PhaseRail } from "./PhaseRail";
import { PHASES, type PhaseId } from "./phases";
import { BlockCanvas, AddBlockBar } from "./BlockCanvas";
import { SchematicView } from "./SchematicView";
import { ArchitectureProposal } from "./ArchitectureProposal";
import { ComponentsPanel } from "./ComponentsPanel";
import { RequirementsPanel } from "./RequirementsPanel";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { WakeCadencePanel } from "./WakeCadencePanel";
import { FirmwarePanel } from "./FirmwarePanel";
import { SimulatePanel } from "./SimulatePanel";
import { BringUpPanel } from "./BringUpPanel";
import { OptimizePanel } from "./OptimizePanel";
import { PowerBudgetPanel } from "./PowerBudgetPanel";
import { FindingsPanel } from "./FindingsPanel";

const anyGrounding = (rows: { status: string }[] | undefined): boolean =>
  rows?.some((r) => r.status === "grounding") ?? false;

/** One plain sentence per phase: what doing this step actually means. */
const PHASE_ACTION: Record<PhaseId, string> = {
  scope: "Write what this thing must do. One line each — numbers can come later.",
  architecture: "Sketch the blocks and wire them. Drag to place, connect the dots to wire.",
  components: "Bind each block to a real part. Suggestions are ranked for your library.",
  electrical: "Set connection voltages and the wake cadence — the checks run as you go.",
  firmware: "Generate the pin map and project files from your design.",
  simulate: "Run the firmware on a simulated board — before buying anything.",
  bringup: "Power it on for the first time, step by step.",
  optimize: "Measure real currents and compare against the estimates.",
};

/**
 * The project workspace as a guided stepper: exactly one phase on screen,
 * Continue/Back to walk the build order, the rail free to jump anywhere. The
 * inspector (power budget + findings) stays put — consequences are always in
 * view no matter which step you're on.
 */
export function ProjectDetailPage() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const qc = useQueryClient();
  const [activePhase, setActivePhase] = useState<PhaseId>(() => {
    // come back to where you left off — a stepper that forgets is a form
    const saved = localStorage.getItem(`embedded:phase:${projectId}`);
    return PHASES.some((p) => p.id === saved) ? (saved as PhaseId) : "scope";
  });
  const [capacityOverride, setCapacityOverride] = useState<number | null>(null);
  const [archView, setArchView] = useState<"diagram" | "schematic">("diagram");

  const goToPhase = (id: PhaseId) => {
    setActivePhase(id);
    localStorage.setItem(`embedded:phase:${projectId}`, id);
    // each step starts at its top — carrying scroll position between steps is disorienting
    window.scrollTo({ top: 0 });
  };

  const { data: project } = useQuery({
    queryKey: ["project", projectId],
    queryFn: () => api.projects.get(projectId),
  });
  const { data: archetype } = useQuery({
    queryKey: ["archetype", project?.archetypeId],
    queryFn: () => api.archetypes.get(project!.archetypeId!),
    enabled: Boolean(project?.archetypeId),
  });

  const { data: grounding } = useQuery({
    queryKey: ["grounding", projectId],
    queryFn: () => api.projects.grounding(projectId),
    refetchInterval: (query) => (anyGrounding(query.state.data) ? 800 : false),
  });

  // when grounding settles, the freshly-read specs feed the budget and rules
  const stillGrounding = anyGrounding(grounding);
  const [wasGrounding, setWasGrounding] = useState(false);
  if (stillGrounding !== wasGrounding) {
    setWasGrounding(stillGrounding);
    if (!stillGrounding) {
      qc.invalidateQueries({ queryKey: ["power-budget", projectId] });
      qc.invalidateQueries({ queryKey: ["findings", projectId] });
    }
  }

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["blocks", projectId] });
    qc.invalidateQueries({ queryKey: ["connections", projectId] });
    qc.invalidateQueries({ queryKey: ["grounding", projectId] });
    qc.invalidateQueries({ queryKey: ["power-budget", projectId] });
    qc.invalidateQueries({ queryKey: ["findings", projectId] });
  };

  const archetypeId = project?.archetypeId;
  const stepIndex = PHASES.findIndex((p) => p.id === activePhase);
  const phase = PHASES[stepIndex]!;
  const prev = stepIndex > 0 ? PHASES[stepIndex - 1] : undefined;
  const next = stepIndex < PHASES.length - 1 ? PHASES[stepIndex + 1] : undefined;

  const surface: Record<PhaseId, ReactNode> = {
    scope: <RequirementsPanel projectId={projectId} />,
    architecture: (
      <Panel>
        <PanelHeader
          title="Architecture"
          aside={
            <div className="flex items-center gap-3">
              <span>
                {archView === "diagram" ? "drag to place · connect handles to wire" : "derived · not editable"}
              </span>
              <div className="flex gap-1">
                <Button
                  variant={archView === "diagram" ? "primary" : "ghost"}
                  size="sm"
                  onClick={() => setArchView("diagram")}
                >
                  Diagram
                </Button>
                <Button
                  variant={archView === "schematic" ? "primary" : "ghost"}
                  size="sm"
                  onClick={() => setArchView("schematic")}
                >
                  Schematic
                </Button>
              </div>
            </div>
          }
        />
        {archView === "diagram" ? (
          <>
            <BlockCanvas projectId={projectId} />
            <AddBlockBar projectId={projectId} />
            <ArchitectureProposal projectId={projectId} onApplied={invalidate} />
          </>
        ) : (
          <SchematicView projectId={projectId} />
        )}
      </Panel>
    ),
    components: <ComponentsPanel projectId={projectId} {...(archetypeId ? { archetypeId } : {})} />,
    electrical: (
      <div className="space-y-4">
        <ConnectionsPanel projectId={projectId} />
        <WakeCadencePanel projectId={projectId} capacityOverride={capacityOverride} />
      </div>
    ),
    firmware: <FirmwarePanel projectId={projectId} />,
    simulate: <SimulatePanel projectId={projectId} />,
    bringup: <BringUpPanel projectId={projectId} {...(archetypeId ? { archetypeId } : {})} />,
    optimize: <OptimizePanel projectId={projectId} />,
  };

  return (
    <div className="flex min-h-full">
      <PhaseRail
        projectId={projectId}
        projectName={project?.name}
        archetypeName={archetype?.name}
        activePhase={activePhase}
        onSelect={goToPhase}
      />

      <div className="flex min-w-0 flex-1 flex-col items-start xl:flex-row">
        <div className="min-w-0 flex-1 px-8 py-8">
          {/* step header: where you are and what this step is for */}
          <header className="mb-4">
            <p className="num text-[10px] uppercase tracking-widest text-ink-faint">
              step {stepIndex + 1} of {PHASES.length}
            </p>
            <h2 className="mt-0.5 text-lg font-semibold text-ink">{phase.label}</h2>
            <p className="mt-0.5 text-xs text-ink-dim">{PHASE_ACTION[phase.id]}</p>
          </header>

          <div id={phase.id}>{surface[phase.id]}</div>

          {/* step footer: the one obvious way forward (and back) */}
          <footer className="mt-6 flex items-center justify-between">
            {prev ? (
              <Button variant="ghost" size="md" onClick={() => goToPhase(prev.id)}>
                ← {prev.label}
              </Button>
            ) : (
              <span />
            )}
            {next ? (
              <Button variant="primary" size="md" onClick={() => goToPhase(next.id)}>
                Continue → {next.label}
              </Button>
            ) : (
              <span className="text-[11px] text-ink-faint">
                Last step — iterate here as the hardware talks back.
              </span>
            )}
          </footer>
        </div>

        {/* inspector: the live consequences, always in view */}
        <aside className="w-full shrink-0 space-y-4 px-8 pb-10 pt-8 xl:sticky xl:top-0 xl:h-screen xl:w-[372px] xl:overflow-y-auto xl:px-5 xl:pt-8">
          <PowerBudgetPanel
            projectId={projectId}
            capacityOverride={capacityOverride}
            onCapacityChange={setCapacityOverride}
          />
          <FindingsPanel projectId={projectId} />
        </aside>
      </div>
    </div>
  );
}
