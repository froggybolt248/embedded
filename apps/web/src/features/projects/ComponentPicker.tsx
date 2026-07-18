import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { BlockRole, Component, ComponentCategory, PartHint } from "@embedded/core";
import { api } from "../../lib/api";

/**
 * Search-and-bind over a 22k-part library.
 *
 * A raw search box asks the designer to already know the answer, so the picker
 * leads with suggestions: the archetype's known-good picks when the block has
 * them, otherwise parts from the block's own category. Typing narrows within
 * that category by default — the full-library search is one click away, not
 * the default firehose.
 */

/** Which library category a block role shops in. `other` searches everything. */
const ROLE_CATEGORY: Partial<Record<BlockRole, ComponentCategory>> = {
  mcu: "mcu",
  sensor: "sensor",
  radio: "radio",
  power: "power",
  actuator: "actuator-driver",
  display: "display",
};

export function ComponentPicker({
  hint,
  role,
  onPick,
  onCancel,
}: {
  hint?: PartHint | undefined;
  role?: BlockRole | undefined;
  onPick: (componentId: string) => void;
  onCancel: () => void;
}) {
  const [q, setQ] = useState("");
  const [touched, setTouched] = useState(false);
  const [allCategories, setAllCategories] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const category = hint?.category ?? (role ? ROLE_CATEGORY[role] : undefined);

  // the archetype's known-good picks, resolved against the actual library so a
  // part the library doesn't have simply doesn't appear
  const { data: preferred } = useQuery({
    queryKey: ["components", "preferred", hint?.prefer],
    queryFn: () => api.components.list({ mpns: hint!.prefer }),
    enabled: Boolean(hint?.prefer?.length),
  });

  // suggestions before the user types: the archetype's search when there is
  // one, else simply the block's category (ranked server-side: parts with real
  // power data first) — so every block offers starting points, not a blank box
  const suggestQ = hint?.q ?? "";
  const showSuggested = !touched && (suggestQ !== "" || category !== undefined);
  const { data: suggested } = useQuery({
    queryKey: ["components", "suggested", suggestQ, category],
    queryFn: () =>
      api.components.list({
        ...(suggestQ ? { q: suggestQ.split(" ")[0]! } : {}),
        ...(category ? { category } : {}),
        limit: 6,
      }),
    enabled: showSuggested,
  });

  // typing keeps the category filter unless the user widens it — dropping the
  // filter silently is how a sensor search turns into a firehose of connectors
  const effectiveCategory = allCategories ? undefined : category;
  const { data: results, isFetching } = useQuery({
    queryKey: ["components", "picker", q, effectiveCategory],
    queryFn: () =>
      api.components.list({
        q,
        ...(effectiveCategory ? { category: effectiveCategory } : {}),
        limit: 8,
      }),
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
        <span className="flex min-w-0 items-baseline gap-1.5">
          {starred && <span className="shrink-0 text-[10px] text-accent">★</span>}
          <span className="shrink-0 font-mono text-xs text-ink">{c.mpn}</span>
          {/* what the part IS matters more to a maker than who sells it */}
          <span className="truncate text-[11px] text-ink-faint">
            {c.description || c.manufacturer || c.category}
          </span>
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
          category ? `Search ${category} parts…` : "Search parts — BME280, nRF52840, SX1262…"
        }
        className="w-full rounded border border-line bg-surface-1 px-2.5 py-1.5 text-sm outline-none placeholder:text-ink-faint focus:border-accent-dim"
      />

      {searching && category && (
        <div className="mt-1 flex items-center gap-2 px-1 text-[10px] text-ink-faint">
          {allCategories ? (
            <>
              searching everything ·
              <button onClick={() => setAllCategories(false)} className="text-accent hover:underline">
                only {category}
              </button>
            </>
          ) : (
            <>
              searching {category} only ·
              <button onClick={() => setAllCategories(true)} className="text-accent hover:underline">
                search everything
              </button>
            </>
          )}
        </div>
      )}

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
                {category ? `${category} parts in your library` : "In your library"}
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
              {effectiveCategory ? (
                <>
                  No {effectiveCategory} parts match.{" "}
                  <button onClick={() => setAllCategories(true)} className="text-accent hover:underline">
                    Search everything
                  </button>{" "}
                  instead?
                </>
              ) : (
                <>Nothing matches. Import parts from Library → Sources, or ingest a datasheet.</>
              )}
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
