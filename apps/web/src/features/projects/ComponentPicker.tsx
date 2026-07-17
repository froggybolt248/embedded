import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Component, PartHint } from "@embedded/core";
import { api } from "../../lib/api";

/**
 * Search-and-bind over a 22k-part library.
 *
 * A raw search box asks the designer to already know the answer. When the
 * block came from an archetype it carries a `hint`: the search a designer
 * would have run, plus the parts worth starting from. Those are shown first,
 * unprompted, so the common case is picking from three sensible options and
 * the search box is the escape hatch rather than the front door.
 */
export function ComponentPicker({
  hint,
  onPick,
  onCancel,
}: {
  hint?: PartHint | undefined;
  onPick: (componentId: string) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState("");
  const [touched, setTouched] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  // the archetype's known-good picks, resolved against the actual library so a
  // part the library doesn't have simply doesn't appear
  const { data: preferred } = useQuery({
    queryKey: ["components", "preferred", hint?.prefer],
    queryFn: () => api.components.list({ mpns: hint!.prefer }),
    enabled: Boolean(hint?.prefer?.length),
  });

  // the search the archetype would have run, until the user types their own
  const suggestQ = hint?.q ?? "";
  const showSuggested = !touched && (suggestQ !== "" || hint?.category !== undefined);
  const { data: suggested } = useQuery({
    queryKey: ["components", "suggested", suggestQ, hint?.category],
    queryFn: () =>
      api.components.list({
        ...(suggestQ ? { q: suggestQ.split(" ")[0]! } : {}),
        ...(hint?.category ? { category: hint.category } : {}),
        limit: 6,
      }),
    enabled: showSuggested,
  });

  const { data: results, isFetching } = useQuery({
    queryKey: ["components", "picker", q],
    queryFn: () => api.components.list({ q, limit: 8 }),
    enabled: q.trim().length >= 2,
  });

  const preferredIds = new Set((preferred ?? []).map((c) => c.id));
  const searching = q.trim().length >= 2;

  const Row = ({ c, starred }: { c: Component; starred?: boolean }) => (
    <li>
      <button
        onClick={() => onPick(c.id)}
        className="flex w-full items-baseline justify-between gap-3 rounded px-2 py-1.5 text-left hover:bg-surface-3"
      >
        <span className="flex items-baseline gap-1.5">
          {starred && <span className="text-[10px] text-accent">★</span>}
          <span className="font-mono text-xs text-ink">{c.mpn}</span>
        </span>
        <span className="truncate text-[11px] text-ink-faint">
          {c.manufacturer || c.description || c.category}
        </span>
      </button>
    </li>
  );

  return (
    <div className="mt-2 rounded-md border border-accent-dim bg-surface-2 p-2">
      <input
        ref={inputRef}
        value={q}
        onChange={(e) => {
          setQ(e.target.value);
          setTouched(true);
        }}
        onKeyDown={(e) => e.key === "Escape" && onCancel()}
        placeholder={
          hint?.q ? `Search parts, or start from a suggestion below…` : "Search parts — BME280, nRF52840, SX1262…"
        }
        className="w-full rounded border border-line bg-surface-1 px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint focus:border-accent-dim"
      />

      {!searching && (preferred?.length || suggested?.length) ? (
        <div className="mt-1.5 max-h-64 overflow-y-auto">
          {preferred && preferred.length > 0 && (
            <>
              <p className="px-2 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-ink-faint">
                Good starting points
              </p>
              <ul>
                {preferred.map((c) => (
                  <Row key={c.id} c={c} starred />
                ))}
              </ul>
            </>
          )}
          {suggested && suggested.filter((c) => !preferredIds.has(c.id)).length > 0 && (
            <>
              <p className="px-2 pb-0.5 pt-2 text-[10px] uppercase tracking-wide text-ink-faint">
                Others in your library
              </p>
              <ul>
                {suggested
                  .filter((c) => !preferredIds.has(c.id))
                  .map((c) => (
                    <Row key={c.id} c={c} />
                  ))}
              </ul>
            </>
          )}
        </div>
      ) : null}

      {searching && (
        <ul className="mt-1.5 max-h-56 overflow-y-auto">
          {isFetching && results === undefined && (
            <li className="px-2 py-2 text-xs text-ink-faint">Searching…</li>
          )}
          {results?.length === 0 && (
            <li className="px-2 py-2 text-xs text-ink-faint">
              Nothing matches. Import the KiCad library from Library → Sources, or ingest a
              datasheet.
            </li>
          )}
          {results?.map((c) => (
            <Row key={c.id} c={c} starred={preferredIds.has(c.id)} />
          ))}
        </ul>
      )}
    </div>
  );
}
