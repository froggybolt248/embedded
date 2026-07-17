import { useEffect, useRef, useState } from "react";
import type { SourcedValue } from "@embedded/core";

const SOURCE_LABEL: Record<SourcedValue["source"]["kind"], string> = {
  datasheet: "datasheet",
  manual: "manual entry",
  calculator: "calculator",
  llm: "llm extraction",
};

/**
 * A chip rendering a SourcedValue. Hover or click reveals a small popover
 * with the value in mono, its source kind, verification state, and the
 * conditions under which it holds. Click pins the popover open.
 */
export function ProvenancePopover({ value }: { value: SourcedValue }) {
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  const open = hovered || pinned;

  useEffect(() => {
    if (!pinned) return;
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setPinned(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [pinned]);

  const verifiedBy = value.source.verifiedBy;

  return (
    <span
      ref={ref}
      className="relative inline-block"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => setPinned((p) => !p)}
        className={`num inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs transition-colors ${
          open ? "border-accent-dim bg-surface-3 text-ink" : "border-line bg-surface-2 text-ink-dim"
        }`}
      >
        {value.bound && <span className="text-[9px] uppercase text-ink-faint">{value.bound}</span>}
        {value.value}
        <span className="text-ink-faint">{value.unit}</span>
      </button>

      {open && (
        <div className="absolute left-0 top-full z-30 mt-1.5 w-56 rounded-md border border-line bg-surface-2 p-3 shadow-lg shadow-black/50">
          <div className="num mb-2 text-sm text-ink">
            {value.value} <span className="text-ink-dim">{value.unit}</span>
            {value.bound && (
              <span className="ml-2 rounded bg-surface-3 px-1 py-0.5 text-[10px] uppercase text-ink-faint">
                {value.bound}
              </span>
            )}
          </div>
          <div className="flex items-center justify-between text-[11px]">
            <span className="text-ink-faint">
              source <span className="text-ink-dim">{SOURCE_LABEL[value.source.kind]}</span>
              {value.source.page !== undefined && (
                <span className="num text-ink-faint"> · p.{value.source.page}</span>
              )}
            </span>
            {verifiedBy === "human" ? (
              <span className="rounded bg-ok/15 px-1.5 py-0.5 font-medium text-ok">verified</span>
            ) : verifiedBy === "machine" ? (
              <span
                className="rounded bg-ok/15 px-1.5 py-0.5 font-medium text-ok"
                title="Copied verbatim from the datasheet text layer and grounding-checked — no LLM transcription involved."
              >
                machine-verified
              </span>
            ) : (
              <span className="rounded bg-warn/15 px-1.5 py-0.5 font-medium text-warn">
                unverified
              </span>
            )}
          </div>
          {value.source.confidence !== undefined && (
            <div className="num mt-1 text-[11px] text-ink-faint">
              confidence {Math.round(value.source.confidence * 100)}%
            </div>
          )}
          {value.conditions && (
            <div className="mt-2 border-t border-line pt-2 text-[11px] text-ink-dim">
              <span className="text-ink-faint">conditions </span>
              <span className="num">{value.conditions}</span>
            </div>
          )}
          {value.source.snippet && (
            <div className="mt-2 border-t border-line pt-2 font-mono text-[10px] text-ink-faint">
              “{value.source.snippet}”
            </div>
          )}
        </div>
      )}
    </span>
  );
}
