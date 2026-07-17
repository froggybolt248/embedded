import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type WakeTradeoffOption } from "../../lib/api";

const formatMa = (ma: number): string => {
  if (ma === 0) return "0";
  if (ma < 0.001) return `${(ma * 1_000_000).toPrecision(3)} nA`;
  if (ma < 1) return `${(ma * 1000).toPrecision(3)} µA`;
  return `${ma.toPrecision(3)} mA`;
};

/**
 * "How often does your device need to wake?" — the question no datasheet can
 * answer. Each candidate cadence is priced against the real battery so the
 * designer's answer has a cost attached, not just a feeling.
 *
 * Takes only what the USER chose (`capacityOverride`). Which battery and which
 * life target this design is judged against are the server's to decide from the
 * archetype, and the answer comes back on the response — this view renders that,
 * it does not re-derive it.
 *
 * Picking a cadence WRITES it to the design's blocks. An answer that evaporates
 * on reload is not an answer, and the budget would quietly drift back to a
 * default the designer never chose.
 */
export function WakeCadencePanel({
  projectId,
  capacityOverride,
}: {
  projectId: string;
  /** null/undefined both mean "the user has not overridden it" — the server decides */
  capacityOverride?: number | null | undefined;
}) {
  const qc = useQueryClient();

  const { data: tradeoff, isLoading } = useQuery({
    queryKey: ["wake-tradeoff", projectId, capacityOverride],
    queryFn: () =>
      api.projects.wakeTradeoff(projectId, {
        ...(capacityOverride != null ? { batteryCapacityMah: capacityOverride } : {}),
      }),
  });

  // Fetched separately: a slow or failing suggestion must never delay or
  // break the priced options above — the LLM is deliberately off the
  // critical path.
  const { data: proposalResult } = useQuery({
    queryKey: ["wake-proposal", projectId],
    queryFn: () => api.projects.wakeProposal(projectId),
    retry: false,
  });
  const proposal = proposalResult?.proposal ?? null;

  // The design's own answer, not this component's memory of a click: after the
  // write lands the server reports which cadence is saved, and an untouched
  // design reports none rather than presenting a default as a decision.
  const selected = tradeoff?.savedEverySec ?? null;

  const choose = useMutation({
    mutationFn: (everySec: number) => api.projects.wakeCadence(projectId, everySec),
    onSuccess: () => {
      // the choice changes the budget and the blocks, not just this panel
      qc.invalidateQueries({ queryKey: ["wake-tradeoff", projectId] });
      qc.invalidateQueries({ queryKey: ["power-budget", projectId] });
      qc.invalidateQueries({ queryKey: ["blocks", projectId] });
    },
  });

  return (
    <section className="rounded-lg border border-line bg-surface-1">
      <h2 className="flex items-baseline justify-between border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        <span>Wake cadence</span>
        {tradeoff && tradeoff.options.length > 0 && (
          <span className="font-normal normal-case tracking-normal text-ink-faint">
            priced against{" "}
            <span className="num text-ink-dim">{tradeoff.batteryCapacityMah} mAh</span>
            {tradeoff.batteryLabel ? ` — ${tradeoff.batteryLabel}` : ""}
          </span>
        )}
      </h2>

      {isLoading && (
        <div className="px-4 py-6 text-center text-xs text-ink-faint">Pricing cadences…</div>
      )}

      {tradeoff && tradeoff.options.length === 0 && (
        <div className="px-4 py-6 text-center text-xs text-ink-faint">
          No grounded parts yet, so no cadence has a real cost — bind a part to a block first.
        </div>
      )}

      {tradeoff && tradeoff.options.length > 0 && (
        <>
          {tradeoff.targetUnreachable && (
            <div className="border-b border-warn/30 bg-warn/5 px-4 py-2.5 text-[11px] text-warn">
              <span className="font-medium">✗ No cadence reaches the goal.</span>{" "}
              <span className="text-ink-dim">
                Slowing the wake rate further won't help — the part choice or the battery is the
                problem.
              </span>
            </div>
          )}

          <ul>
            {tradeoff.options.map((o) => (
              <OptionRow
                key={o.everySec}
                option={o}
                selected={selected === o.everySec}
                pending={choose.isPending && choose.variables === o.everySec}
                suggested={proposal?.everySec === o.everySec ? proposal : null}
                onSelect={() => choose.mutate(o.everySec)}
              />
            ))}
          </ul>
        </>
      )}

      {tradeoff && tradeoff.ungrounded.length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <div className="text-[11px] uppercase tracking-wide text-warn">Not priced in</div>
          <ul className="mt-1.5 flex flex-col gap-1">
            {tradeoff.ungrounded.map((u) => (
              <li key={u.blockId} className="text-[11px] text-ink-faint">
                <span className="text-ink-dim">{u.name}</span> — {u.reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function OptionRow({
  option,
  selected,
  pending,
  suggested,
  onSelect,
}: {
  option: WakeTradeoffOption;
  selected: boolean;
  pending: boolean;
  suggested: { everySec: number; reason: string } | null;
  onSelect: () => void;
}) {
  return (
    <li className="border-b border-line/60 last:border-b-0">
      <button
        onClick={onSelect}
        disabled={pending}
        className={`flex w-full items-center justify-between gap-3 px-4 py-2.5 text-left ${
          selected ? "bg-accent/10" : "hover:bg-surface-2"
        }`}
      >
        <span className="flex min-w-0 flex-col">
          <span className="text-xs text-ink">
            {option.label}
            {selected && <span className="ml-1.5 text-[10px] text-accent">chosen</span>}
            {pending && <span className="ml-1.5 text-[10px] text-ink-faint">saving…</span>}
          </span>
          {suggested && (
            <span className="mt-0.5 text-[10px] text-accent">
              suggested — {suggested.reason}
            </span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {option.meetsTarget === true && <span className="text-ok">✓</span>}
          {option.meetsTarget === false && <span className="text-warn">✗</span>}
          <span className="text-right">
            <span className="num block text-xs text-ink-dim">
              {option.batteryLifeYears.toFixed(1)} yr
            </span>
            <span className="num block text-[10px] text-ink-faint">
              {formatMa(option.averageCurrentMa)} avg
            </span>
          </span>
        </span>
      </button>
    </li>
  );
}
