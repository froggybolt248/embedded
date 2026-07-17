import { useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { SourcedRange } from "@embedded/core";
import { api } from "../../lib/api";
import { ProvenancePopover } from "../../components/ProvenancePopover";
import { CategoryBadge, LifecycleBadge } from "./badges";
import { ComponentFormPanel } from "./ComponentFormPanel";

function RangeChips({ range }: { range: SourcedRange }) {
  const entries = [range.min, range.typ, range.max].filter((v) => v !== undefined);
  if (entries.length === 0) return <span className="text-xs text-ink-faint">—</span>;
  return (
    <span className="inline-flex flex-wrap gap-1.5">
      {entries.map((v, i) => (
        <ProvenancePopover key={i} value={v} />
      ))}
    </span>
  );
}

function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-line bg-surface-1">
      <h2 className="border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        {title}
      </h2>
      {children}
    </section>
  );
}

const thClass = "px-4 py-2 text-left text-[11px] font-medium uppercase tracking-wide text-ink-faint";
const tdClass = "px-4 py-2.5 align-top";

export function ComponentDetailPage() {
  const { componentId } = useParams({ from: "/library/components/$componentId" });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);

  const { data: component, isLoading, isError } = useQuery({
    queryKey: ["component", componentId],
    queryFn: () => api.components.get(componentId),
  });

  const remove = useMutation({
    mutationFn: () => api.components.remove(componentId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["components"] });
      navigate({ to: "/library" });
    },
  });

  // family this part belongs to (if it is a variant)…
  const { data: family } = useQuery({
    queryKey: ["component", component?.familyId],
    queryFn: () => api.components.get(component!.familyId!),
    enabled: Boolean(component?.familyId),
  });
  // …and the variants under it (if it is a family)
  const { data: variants } = useQuery({
    queryKey: ["components", { familyId: componentId }],
    queryFn: () => api.components.list({ familyId: componentId, limit: 500 }),
    enabled: Boolean(component?.isFamily),
  });

  if (isLoading) {
    return <p className="p-8 text-sm text-ink-faint">Loading…</p>;
  }
  if (isError || !component) {
    return (
      <div className="p-8">
        <p className="text-sm text-danger">Component not found.</p>
        <Link to="/library" className="text-sm text-accent hover:underline">
          ← Back to library
        </Link>
      </div>
    );
  }

  const { specs } = component;
  const datasheetUrl = component.variantAttrs["datasheet"];
  const attrEntries = Object.entries(component.variantAttrs).filter(([k]) => k !== "datasheet");
  const ratedSections = [
    { title: "Absolute maximum ratings", rows: specs.absoluteMax },
    { title: "Recommended operating conditions", rows: specs.recommendedOperating },
  ].filter((s) => s.rows.length > 0);

  return (
    <div className="mx-auto max-w-4xl p-8">
      <Link to="/library" className="mb-4 inline-block text-xs text-ink-faint hover:text-accent">
        ← Library
      </Link>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-mono text-2xl font-semibold text-ink">{component.mpn}</h1>
            <CategoryBadge category={component.category} />
            <LifecycleBadge lifecycle={component.lifecycle} />
          </div>
          <p className="mt-1 text-sm text-ink-dim">
            {component.manufacturer || "Unknown manufacturer"}
          </p>
          {component.description && (
            <p className="mt-2 max-w-2xl text-sm text-ink-dim">{component.description}</p>
          )}
          {datasheetUrl && (
            <a
              href={datasheetUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-2 inline-block text-xs text-accent hover:underline"
            >
              datasheet ↗
            </a>
          )}
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            onClick={() => setEditing(true)}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-dim hover:border-accent-dim hover:text-ink"
          >
            Edit
          </button>
          <button
            onClick={() => {
              if (window.confirm(`Delete ${component.mpn} from the library?`)) remove.mutate();
            }}
            disabled={remove.isPending}
            className="rounded-md border border-line px-3 py-1.5 text-sm text-ink-dim hover:border-danger hover:text-danger disabled:opacity-40"
          >
            Delete
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {(component.familyId || component.isFamily || attrEntries.length > 0) && (
          <SectionCard title={component.isFamily ? "Family" : "Part details"}>
            <div className="flex flex-col gap-3 px-4 py-3 text-sm">
              {family && (
                <div>
                  <span className="text-ink-faint">Variant of </span>
                  <Link
                    to="/library/components/$componentId"
                    params={{ componentId: family.id }}
                    className="font-mono text-accent hover:underline"
                  >
                    {family.mpn}
                  </Link>
                </div>
              )}
              {attrEntries.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {attrEntries.map(([k, v]) => (
                    <span
                      key={k}
                      className="rounded bg-surface-3 px-1.5 py-0.5 text-[11px] text-ink-dim"
                    >
                      <span className="text-ink-faint">{k}:</span> {v}
                    </span>
                  ))}
                </div>
              )}
              {component.isFamily && variants && variants.length > 0 && (
                <div>
                  <div className="mb-1.5 text-[11px] uppercase tracking-wide text-ink-faint">
                    {variants.length} {variants.length === 1 ? "variant" : "variants"}
                  </div>
                  <div className="flex flex-wrap gap-1.5">
                    {variants.map((v) => (
                      <Link
                        key={v.id}
                        to="/library/components/$componentId"
                        params={{ componentId: v.id }}
                        className="rounded border border-line px-2 py-0.5 font-mono text-xs text-accent hover:border-accent-dim"
                      >
                        {v.mpn}
                      </Link>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </SectionCard>
        )}

        <SectionCard title="Power states">
          {specs.powerStates.length === 0 ? (
            <p className="px-4 py-4 text-sm text-ink-faint">
              No power states captured. Edit the component to add sleep / active currents.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className={thClass}>State</th>
                  <th className={thClass}>Current</th>
                  <th className={thClass}>Conditions</th>
                </tr>
              </thead>
              <tbody>
                {specs.powerStates.map((ps, i) => (
                  <tr key={i} className="border-b border-line last:border-b-0">
                    <td className={`${tdClass} font-medium`}>{ps.name}</td>
                    <td className={tdClass}>
                      <RangeChips range={ps.current} />
                    </td>
                    <td className={`${tdClass} num text-xs text-ink-faint`}>
                      {ps.conditions || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>

        <SectionCard title="Pins">
          {specs.pins.length === 0 ? (
            <p className="px-4 py-4 text-sm text-ink-faint">No pins captured.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className={thClass}>Pin</th>
                  <th className={thClass}>#</th>
                  <th className={thClass}>Functions</th>
                  <th className={thClass}>Voltage</th>
                </tr>
              </thead>
              <tbody>
                {specs.pins.map((pin, i) => (
                  <tr key={i} className="border-b border-line last:border-b-0">
                    <td className={`${tdClass} font-mono`}>{pin.name}</td>
                    <td className={`${tdClass} num text-ink-faint`}>{pin.number ?? "—"}</td>
                    <td className={tdClass}>
                      {pin.functions.length === 0 ? (
                        <span className="text-xs text-ink-faint">—</span>
                      ) : (
                        <span className="inline-flex flex-wrap gap-1">
                          {pin.functions.map((f) => (
                            <span
                              key={f}
                              className="rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[10px] text-ink-dim"
                            >
                              {f}
                            </span>
                          ))}
                        </span>
                      )}
                    </td>
                    <td className={`${tdClass} num text-xs text-ink-dim`}>{pin.voltage ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </SectionCard>

        {ratedSections.map((section) => (
          <SectionCard key={section.title} title={section.title}>
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line">
                  <th className={thClass}>Parameter</th>
                  <th className={thClass}>Min / Typ / Max</th>
                </tr>
              </thead>
              <tbody>
                {section.rows.map((param) => (
                  <tr key={param.param} className="border-b border-line last:border-b-0">
                    <td className={tdClass}>{param.label}</td>
                    <td className={tdClass}>
                      <RangeChips range={param.range} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </SectionCard>
        ))}
      </div>

      <p className="num mt-6 text-[11px] text-ink-faint">
        added {new Date(component.createdAt).toLocaleString()} · updated{" "}
        {new Date(component.updatedAt).toLocaleString()}
      </p>

      {editing && (
        <ComponentFormPanel initial={component} onClose={() => setEditing(false)} />
      )}
    </div>
  );
}
