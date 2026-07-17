import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useParams } from "@tanstack/react-router";
import { api } from "../../lib/api";
import { Panel, PanelHeader } from "../../components/ui";
import { PhaseRail } from "./PhaseRail";
import { type PhaseId } from "./phases";
import { BlockCanvas, AddBlockBar } from "./BlockCanvas";
import { ArchitectureProposal } from "./ArchitectureProposal";
import { ComponentsPanel } from "./ComponentsPanel";
import { RequirementsPanel } from "./RequirementsPanel";
import { ConnectionsPanel } from "./ConnectionsPanel";
import { WakeCadencePanel } from "./WakeCadencePanel";
import { FirmwarePanel } from "./FirmwarePanel";
import { BringUpPanel } from "./BringUpPanel";
import { OptimizePanel } from "./OptimizePanel";
import { PowerBudgetPanel } from "./PowerBudgetPanel";
import { FindingsPanel } from "./FindingsPanel";

const anyGrounding = (rows: { status: string }[] | undefined): boolean =>
  rows?.some((r) => r.status === "grounding") ?? false;

export function ProjectDetailPage() {
  const { projectId } = useParams({ from: "/projects/$projectId" });
  const qc = useQueryClient();
  const [activePhase, setActivePhase] = useState<PhaseId>("scope");
  const [capacityOverride, setCapacityOverride] = useState<number | null>(null);

  const sectionRefs = useRef<Partial<Record<PhaseId, HTMLElement | null>>>({});

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

  // scroll-spy: the phase whose section crosses the viewport's middle is active
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        if (visible[0]) setActivePhase(visible[0].target.id as PhaseId);
      },
      { rootMargin: "-12% 0px -78% 0px", threshold: 0 },
    );
    for (const el of Object.values(sectionRefs.current)) if (el) observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const goToPhase = (id: PhaseId) => {
    setActivePhase(id);
    sectionRefs.current[id]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const setRef = (id: PhaseId) => (el: HTMLElement | null) => {
    sectionRefs.current[id] = el;
  };

  const archetypeId = project?.archetypeId;

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
        {/* workspace: the phase surfaces, stacked and scroll-spied. The phase
            rail carries the name + blurb of each, so the panels self-title and
            we don't repeat the phase name as a second heading here. */}
        <div className="min-w-0 flex-1 space-y-8 px-8 py-8">
          <Section id="scope" setRef={setRef}>
            <RequirementsPanel projectId={projectId} />
          </Section>

          <Section id="architecture" setRef={setRef}>
            <Panel>
              <PanelHeader title="Architecture" aside="drag to place · connect handles to wire" />
              <BlockCanvas projectId={projectId} />
              <AddBlockBar projectId={projectId} />
              <ArchitectureProposal projectId={projectId} onApplied={invalidate} />
            </Panel>
          </Section>

          <Section id="components" setRef={setRef}>
            <ComponentsPanel projectId={projectId} {...(archetypeId ? { archetypeId } : {})} />
          </Section>

          <Section id="electrical" setRef={setRef}>
            <div className="space-y-4">
              <ConnectionsPanel projectId={projectId} />
              <WakeCadencePanel projectId={projectId} capacityOverride={capacityOverride} />
            </div>
          </Section>

          <Section id="firmware" setRef={setRef}>
            <FirmwarePanel projectId={projectId} />
          </Section>

          <Section id="bringup" setRef={setRef}>
            <BringUpPanel projectId={projectId} {...(archetypeId ? { archetypeId } : {})} />
          </Section>

          <Section id="optimize" setRef={setRef}>
            <OptimizePanel projectId={projectId} />
          </Section>
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

/** A phase's workspace surface — the landmark the rail scroll-spies and jumps to. */
function Section({
  id,
  setRef,
  children,
}: {
  id: PhaseId;
  setRef: (id: PhaseId) => (el: HTMLElement | null) => void;
  children: ReactNode;
}) {
  // a div, not a section: each panel already renders its own <section>, and a
  // second wrapping section would make "the Architecture section" ambiguous.
  return (
    <div id={id} ref={setRef(id)} className="scroll-mt-6">
      {children}
    </div>
  );
}
