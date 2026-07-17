import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { PowerMode } from "@embedded/core";
import {
  api,
  type DutyCycle,
  type DutyOverrides,
  type PowerBudgetResult,
  type PowerContribution,
  type StateContribution,
} from "../../lib/api";
import { ProvenancePopover } from "../../components/ProvenancePopover";

/** Battery life reads better in whatever unit keeps it a small number. */
function formatLife(result: PowerBudgetResult): { value: string; unit: string } {
  if (!Number.isFinite(result.batteryLifeHours)) return { value: "∞", unit: "" };
  if (result.batteryLifeYears >= 1) return { value: result.batteryLifeYears.toFixed(1), unit: "years" };
  if (result.batteryLifeDays >= 1) return { value: result.batteryLifeDays.toFixed(1), unit: "days" };
  return { value: result.batteryLifeHours.toFixed(1), unit: "hours" };
}

const formatMa = (ma: number): string => {
  if (ma === 0) return "0";
  if (ma < 0.001) return `${(ma * 1_000_000).toPrecision(3)} nA`;
  if (ma < 1) return `${(ma * 1000).toPrecision(3)} µA`;
  return `${ma.toPrecision(3)} mA`;
};

const MODE_LABEL: Record<PowerMode, string> = {
  sleep: "asleep",
  standby: "on standby",
  active: "awake",
  tx: "transmitting",
  rx: "listening",
  refresh: "refreshing",
};

/** "every 60 s for 100 ms" — the way the duty was actually decided. */
function DutyEditor({
  duty,
  onChange,
}: {
  duty: DutyCycle;
  onChange: (d: DutyCycle) => void;
}) {
  const input =
    "num w-14 rounded border border-line bg-surface-1 px-1 py-0.5 text-[11px] outline-none focus:border-accent-dim";
  return (
    <span className="inline-flex items-center gap-1 text-[10px] text-ink-faint">
      every
      <input
        type="number"
        min={0.001}
        step="any"
        value={duty.everySec}
        onChange={(e) => onChange({ ...duty, everySec: Number(e.target.value) || 0.001 })}
        className={input}
      />
      s for
      <input
        type="number"
        min={0}
        step="any"
        value={duty.forMs}
        onChange={(e) => onChange({ ...duty, forMs: Math.max(0, Number(e.target.value)) })}
        className={input}
      />
      ms
    </span>
  );
}

function StateRow({
  state,
  onDuty,
}: {
  state: StateContribution;
  onDuty: (mode: PowerMode, d: DutyCycle) => void;
}) {
  return (
    <div className="mt-1.5 border-l border-line pl-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[11px] text-ink-dim">
          {MODE_LABEL[state.mode]}
          <span className="num ml-1.5 text-ink-faint">{(state.fraction * 100).toPrecision(2)}%</span>
        </span>
        <span className="num text-[11px] text-ink-faint">{formatMa(state.averageMa)} avg</span>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
        <DutyEditor duty={state.duty} onChange={(d) => onDuty(state.mode, d)} />
        {state.source && (
          <span className="flex items-center gap-1">
            <span className="text-[10px] text-ink-faint">draws</span>
            <ProvenancePopover value={{ value: state.ma, unit: "mA", source: state.source }} />
          </span>
        )}
      </div>
    </div>
  );
}

function ContributionCard({
  c,
  onDuty,
}: {
  c: PowerContribution;
  onDuty: (blockId: string, mode: PowerMode, d: DutyCycle) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-line/60 px-4 py-2.5 last:border-b-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-baseline justify-between gap-3 text-left"
      >
        <span className="truncate text-xs text-ink">
          <span className="mr-1 text-ink-faint">{open ? "▾" : "▸"}</span>
          {c.label}
        </span>
        <span className="num shrink-0 text-xs text-ink-dim">
          {formatMa(c.averageMa)}
          <span className="ml-1.5 text-ink-faint">{c.sharePct.toFixed(0)}%</span>
        </span>
      </button>

      <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full bg-accent-dim" style={{ width: `${c.sharePct}%` }} />
      </div>

      {c.overCommitted && (
        <p className="mt-1.5 text-[10px] text-warn">
          This part is asked to do more than 100% of the time — shares were rescaled to fit.
        </p>
      )}

      {open && (
        <div className="mt-1">
          {c.states.map((s) => (
            <StateRow key={s.mode} state={s} onDuty={(mode, d) => onDuty(c.id, mode, d)} />
          ))}
          <div className="mt-1.5 border-l border-line pl-2.5">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-[11px] text-ink-dim">
                asleep
                <span className="num ml-1.5 text-ink-faint">
                  {(c.sleepFraction * 100).toPrecision(3)}%
                </span>
              </span>
              {c.sleepSource ? (
                <ProvenancePopover value={{ value: c.sleepMa, unit: "mA", source: c.sleepSource }} />
              ) : (
                // never quietly imply a datasheet said zero
                <span className="text-[10px] text-warn">sleep current not documented</span>
              )}
            </div>
          </div>
        </div>
      )}
    </li>
  );
}

/**
 * Does the estimate meet the goal the archetype set? This is the loop closing:
 * "runs a year on a coin cell" started as the reason for the project, and the
 * same sentence now gets a yes or a no out of datasheet-cited numbers.
 *
 * Only shown when parts are actually grounded — a verdict computed from an
 * empty budget would be a lie dressed as a checkmark.
 */
function TargetVerdict({ budget }: { budget: PowerBudgetResult }) {
  // no stated goal, or nothing grounded to judge — either way there is no
  // verdict to render, and a checkmark computed from an empty budget is a lie
  if (budget.targetLifeYears === undefined || budget.contributions.length === 0) return null;
  const target = budget.targetLifeYears;
  const met = budget.batteryLifeYears >= target;
  const short = budget.ungrounded.length > 0;

  return (
    <div
      className={`border-t px-4 py-2.5 text-[11px] ${
        met ? "border-ok/30 bg-ok/5 text-ok" : "border-warn/30 bg-warn/5 text-warn"
      }`}
    >
      <span className="font-medium">{met ? "✓ Meets the goal" : "✗ Short of the goal"}</span>
      <span className="text-ink-dim">
        {" "}
        — needs {target} {target === 1 ? "year" : "years"} on{" "}
        {budget.batteryLabel || `${budget.batteryCapacityMah} mAh`}
        {short ? "; some parts aren't counted yet, so this will only get worse" : ""}
      </span>
    </div>
  );
}

export function PowerBudgetPanel({
  projectId,
  capacityOverride,
  onCapacityChange,
}: {
  projectId: string;
  /** null/undefined both mean "the user has not overridden it" — the server decides */
  capacityOverride?: number | null | undefined;
  onCapacityChange: (v: number) => void;
}) {
  const [duties, setDuties] = useState<DutyOverrides>({});

  const { data: budget } = useQuery({
    queryKey: ["power-budget", projectId, capacityOverride, duties],
    queryFn: () =>
      api.projects.powerBudget(projectId, {
        ...(capacityOverride != null ? { batteryCapacityMah: capacityOverride } : {}),
        duties,
      }),
  });

  const setDuty = (blockId: string, mode: PowerMode, duty: DutyCycle) =>
    setDuties((prev) => ({ ...prev, [blockId]: { ...prev[blockId], [mode]: duty } }));

  const life = budget ? formatLife(budget) : null;

  return (
    <section className="rounded-lg border border-line bg-surface-1">
      <h2 className="border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        Power budget
      </h2>

      <label className="block border-b border-line px-4 py-3">
        <span className="text-[11px] text-ink-faint">
          Battery capacity (mAh){budget?.batteryLabel ? ` — ${budget.batteryLabel}` : ""}
        </span>
        <input
          type="number"
          min={1}
          // the design's battery until the designer says otherwise; empty only
          // in the instant before the first response lands
          value={capacityOverride ?? budget?.batteryCapacityMah ?? ""}
          onChange={(e) => onCapacityChange(Number(e.target.value) || 1)}
          className="num mt-1.5 w-full rounded border border-line bg-surface-2 px-2 py-1 text-sm outline-none focus:border-accent-dim"
        />
      </label>

      {budget && (
        <>
          <TargetVerdict budget={budget} />
          <div className="flex items-baseline justify-between px-4 py-4">
            <div>
              <div className="num text-2xl font-semibold text-ink">
                {life!.value} <span className="text-base font-normal text-ink-dim">{life!.unit}</span>
              </div>
              <div className="text-[11px] text-ink-faint">estimated battery life</div>
            </div>
            <div className="text-right">
              <div className="num text-sm text-ink-dim">{formatMa(budget.averageCurrentMa)}</div>
              <div className="text-[11px] text-ink-faint">average draw</div>
            </div>
          </div>

          {budget.contributions.length > 0 && (
            <>
              <p className="border-t border-line px-4 pt-2.5 text-[10px] text-ink-faint">
                Currents are from each part's datasheet. How often each part runs is an{" "}
                <span className="text-ink-dim">assumption</span> — open a part to correct it.
              </p>
              <ul>
                {budget.contributions
                  .slice()
                  .sort((a, b) => b.averageMa - a.averageMa)
                  .map((c) => (
                    <ContributionCard key={c.id} c={c} onDuty={setDuty} />
                  ))}
              </ul>
            </>
          )}

          {budget.ungrounded.length > 0 && (
            <div className="border-t border-line px-4 py-3">
              <div className="text-[11px] uppercase tracking-wide text-warn">
                Not in this estimate
              </div>
              <ul className="mt-1.5 flex flex-col gap-1">
                {budget.ungrounded.map((u) => (
                  <li key={u.blockId} className="text-[11px] text-ink-faint">
                    <span className="text-ink-dim">{u.name}</span> — {u.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {budget.contributions.length === 0 && (
            <div className="border-t border-line px-4 py-6 text-center text-xs text-ink-faint">
              Bind a part to a block and its currents land here, straight from its datasheet.
            </div>
          )}
        </>
      )}
    </section>
  );
}
