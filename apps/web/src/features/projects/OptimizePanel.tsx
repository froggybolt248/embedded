import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Block, PowerMode } from "@embedded/core";
import { api, type PowerContribution } from "../../lib/api";

const MODE_LABEL: Record<PowerMode, string> = {
  sleep: "asleep",
  standby: "on standby",
  active: "awake",
  tx: "transmitting",
  rx: "listening",
  refresh: "refreshing",
};

const formatMa = (ma: number): string => {
  if (ma === 0) return "0";
  if (ma < 0.001) return `${(ma * 1_000_000).toPrecision(3)} nA`;
  if (ma < 1) return `${(ma * 1000).toPrecision(3)} µA`;
  return `${ma.toPrecision(3)} mA`;
};

/** Input text -> mA value: empty means NOT MEASURED, never 0. */
function numOrUndefined(s: string): number | undefined {
  if (s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * measured − estimated, and the same delta as a percentage of the estimate.
 * Neutral color throughout — a measurement disagreeing with the datasheet is
 * information the designer asked for, not a fault to flag.
 */
function DeltaBadge({ estimatedMa, measuredMa }: { estimatedMa: number; measuredMa: number }) {
  const delta = measuredMa - estimatedMa;
  const sign = delta > 0 ? "+" : delta < 0 ? "−" : "";
  const pct = estimatedMa !== 0 ? (Math.abs(delta) / estimatedMa) * 100 : undefined;
  return (
    <span className="num text-[10px] text-ink-faint">
      {sign}
      {formatMa(Math.abs(delta))}
      {pct !== undefined ? ` (${sign}${pct.toFixed(0)}%)` : ""}
    </span>
  );
}

function ModeRow({
  mode,
  estimatedMa,
  value,
  onChange,
}: {
  mode: PowerMode;
  estimatedMa: number;
  value: string;
  onChange: (v: string) => void;
}) {
  const measuredMa = numOrUndefined(value);
  return (
    <div className="mt-1.5 flex items-center justify-between gap-2 border-l border-line pl-2.5">
      <span className="text-[11px] text-ink-dim">{MODE_LABEL[mode]}</span>
      <div className="flex items-center gap-2">
        <span className="num text-[11px] text-ink-faint">est. {formatMa(estimatedMa)}</span>
        <input
          type="number"
          step="any"
          placeholder="measured mA"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="num w-24 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[11px] outline-none focus:border-accent-dim"
        />
        {measuredMa !== undefined && <DeltaBadge estimatedMa={estimatedMa} measuredMa={measuredMa} />}
      </div>
    </div>
  );
}

function BlockCard({
  block,
  contribution,
  onSave,
  saving,
}: {
  block: Block;
  contribution: PowerContribution;
  onSave: (measuredMa: Record<string, number>) => void;
  saving: boolean;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const state of contribution.states) {
      const existing = block.measuredMa[state.mode];
      init[state.mode] = existing !== undefined ? String(existing) : "";
    }
    return init;
  });

  const save = () => {
    const measuredMa: Record<string, number> = {};
    for (const [mode, raw] of Object.entries(values)) {
      const n = numOrUndefined(raw);
      if (n !== undefined) measuredMa[mode] = n;
    }
    onSave(measuredMa);
  };

  return (
    <li className="border-b border-line/60 px-4 py-2.5 last:border-b-0">
      <div className="text-xs text-ink">{contribution.label}</div>
      <div className="mt-1.5">
        {contribution.states.map((s) => (
          <ModeRow
            key={s.mode}
            mode={s.mode}
            estimatedMa={s.ma}
            value={values[s.mode] ?? ""}
            onChange={(v) => setValues((prev) => ({ ...prev, [s.mode]: v }))}
          />
        ))}
      </div>
      <div className="mt-2">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 disabled:opacity-40"
        >
          Save measurements
        </button>
      </div>
    </li>
  );
}

/**
 * "Was the estimate right?" — the honest comparison, not a correction. Every
 * bound block with power states gets its datasheet-estimated current per
 * mode alongside a field for what the designer actually measured. A blank
 * field means the mode was never measured; it is never treated as 0, and
 * measured values never overwrite the estimate they are compared against —
 * the estimate stays the datasheet's claim, the measurement stays the
 * designer's own.
 */
export function OptimizePanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();

  const { data: blocks } = useQuery({
    queryKey: ["blocks", projectId],
    queryFn: () => api.blocks.list(projectId),
  });

  const { data: budget } = useQuery({
    queryKey: ["power-budget", projectId, "optimize"],
    queryFn: () => api.projects.powerBudget(projectId, { duties: {} }),
  });

  const save = useMutation({
    mutationFn: ({ blockId, measuredMa }: { blockId: string; measuredMa: Record<string, number> }) =>
      api.blocks.update(blockId, { measuredMa }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["blocks", projectId] }),
  });

  const rows = (blocks ?? [])
    .filter((b) => b.componentId)
    .map((b) => ({ block: b, contribution: budget?.contributions.find((c) => c.id === b.id) }))
    .filter(
      (r): r is { block: Block; contribution: PowerContribution } =>
        r.contribution !== undefined && r.contribution.states.length > 0,
    );

  return (
    <section className="rounded-lg border border-line bg-surface-1">
      <h2 className="border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        Optimize
      </h2>

      <p className="border-b border-line px-4 py-2.5 text-[10px] text-ink-faint">
        Enter what you actually measured, per mode, and see how it compares to the datasheet
        estimate. A blank field means <span className="text-ink-dim">not measured</span> — it is
        never assumed to be zero.
      </p>

      {rows.length === 0 && (
        <div className="px-4 py-6 text-center text-xs text-ink-faint">
          Bind a part with power states to a block and its modes land here for measurement.
        </div>
      )}

      {rows.length > 0 && (
        <ul>
          {rows.map(({ block, contribution }) => (
            <BlockCard
              key={block.id}
              block={block}
              contribution={contribution}
              onSave={(measuredMa) => save.mutate({ blockId: block.id, measuredMa })}
              saving={save.isPending && save.variables?.blockId === block.id}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
