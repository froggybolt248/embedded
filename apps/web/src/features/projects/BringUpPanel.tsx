import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";

/**
 * The Bring-up phase: an archetype-driven checklist for the first time a
 * board is powered on, plus a probe-rs capability check that GATES a flash
 * affordance rather than presenting a button that would just fail.
 *
 * probe-rs is an optional external CLI — this app never hard-requires it.
 * When it is missing, the panel shows instruction cards instead of a dead
 * button, per the same principle the rest of the app follows for git,
 * ngspice, and kicad-cli: capability-gated, honest about absence.
 *
 * Check-off state is local component state only — it resets on reload.
 * Persisting which steps a designer has completed is out of scope here.
 */
export function BringUpPanel({
  projectId,
  archetypeId,
}: {
  projectId: string;
  archetypeId?: string;
}) {
  const { data: capabilities, isLoading: loadingCapabilities } = useQuery({
    queryKey: ["capabilities"],
    queryFn: () => api.capabilities.get(),
  });

  const { data: archetype } = useQuery({
    queryKey: ["archetype", archetypeId],
    queryFn: () => api.archetypes.get(archetypeId!),
    enabled: Boolean(archetypeId),
  });

  const steps = archetype?.recipe.bringUpChecklist ?? [];

  const [checked, setChecked] = useState<Set<number>>(new Set());
  const toggle = (i: number) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });

  const probeRs = capabilities?.probeRs;

  return (
    <section className="rounded-lg border border-line bg-surface-1">
      <h2 className="flex items-baseline justify-between border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        <span>Bring-up</span>
        {steps.length > 0 && (
          <span className="font-normal normal-case tracking-normal text-ink-faint">
            {checked.size}/{steps.length} checked
          </span>
        )}
      </h2>

      {!archetypeId && (
        <p className="px-4 py-6 text-center text-xs text-ink-faint">
          This project has no archetype, so there is no bring-up checklist to show — the probe
          check below still works on its own.
        </p>
      )}

      {archetypeId && steps.length === 0 && (
        <p className="px-4 py-6 text-center text-xs text-ink-faint">
          This archetype has no bring-up checklist yet.
        </p>
      )}

      {steps.length > 0 && (
        <ul>
          {steps.map((step, i) => (
            <li key={i} className="border-b border-line/60 px-4 py-2.5 last:border-b-0">
              <label className="flex items-start gap-2.5 text-left">
                <input
                  type="checkbox"
                  checked={checked.has(i)}
                  onChange={() => toggle(i)}
                  className="mt-0.5 shrink-0"
                />
                <span>
                  <span
                    className={`block text-xs ${checked.has(i) ? "text-ink-faint line-through" : "text-ink-dim"}`}
                  >
                    {step.text}
                  </span>
                  {step.hint && (
                    <span className="mt-0.5 block text-[11px] text-ink-faint">{step.hint}</span>
                  )}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}

      <div className="border-t border-line px-4 py-3">
        {loadingCapabilities && (
          <p className="text-xs text-ink-faint">Checking for probe-rs…</p>
        )}

        {/* No dead buttons: flashing arrives with the build+simulate pipeline.
            Until then this line only reports what the machine has. */}
        {!loadingCapabilities && probeRs?.present && (
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full bg-ok" />
            <span className="text-[11px] text-ink-faint">
              probe-rs detected{probeRs.version ? ` (v${probeRs.version})` : ""} — ready for flashing
              when firmware builds land
            </span>
          </span>
        )}

        {!loadingCapabilities && probeRs && !probeRs.present && (
          <p className="text-[11px] text-ink-faint">
            Optional: install <span className="font-mono text-ink-dim">probe-rs</span> (probe.rs) to
            flash over a debug probe. The checklist above works without it.
          </p>
        )}
      </div>
    </section>
  );
}
