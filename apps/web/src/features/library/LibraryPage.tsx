import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { ComponentCategory } from "@embedded/core";
import { api } from "../../lib/api";
import { CATEGORY_LABELS, CategoryBadge, LifecycleBadge } from "./badges";
import { ComponentFormPanel } from "./ComponentFormPanel";
import { LibraryTabs } from "./LibraryTabs";

const PAGE_SIZE = 200;

export function LibraryPage() {
  const navigate = useNavigate();
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<ComponentCategory | undefined>(undefined);
  const [adding, setAdding] = useState(false);

  const { data: components, isLoading } = useQuery({
    queryKey: ["components", { q, category }],
    queryFn: () =>
      api.components.list({
        ...(q ? { q } : {}),
        ...(category ? { category } : {}),
        limit: PAGE_SIZE,
      }),
  });

  // faceted counts, computed in SQL so they stay cheap with tens of thousands of parts
  const { data: stats } = useQuery({
    queryKey: ["component-stats"],
    queryFn: api.components.stats,
  });

  const filterItem = (active: boolean) =>
    `flex items-center justify-between gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
      active ? "bg-surface-2 text-accent" : "text-ink-dim hover:bg-surface-2 hover:text-ink"
    }`;

  const count = (n: number | undefined) =>
    n === undefined ? null : (
      <span className="num text-[11px] tabular-nums text-ink-faint">{n.toLocaleString()}</span>
    );

  return (
    <div className="flex h-full">
      {/* category filter rail */}
      <aside className="flex w-48 shrink-0 flex-col gap-1 overflow-y-auto border-r border-line p-3">
        <div className="mb-1 px-3 pt-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
          Categories
        </div>
        <button className={filterItem(category === undefined)} onClick={() => setCategory(undefined)}>
          <span>All</span>
          {count(stats?.total)}
        </button>
        {ComponentCategory.options.map((c) => (
          <button key={c} className={filterItem(category === c)} onClick={() => setCategory(c)}>
            <span>{CATEGORY_LABELS[c]}</span>
            {count(stats?.byCategory[c] ?? 0)}
          </button>
        ))}
      </aside>

      {/* component list */}
      <div className="min-w-0 flex-1 overflow-y-auto p-8">
        <LibraryTabs />
        <div className="mb-6 flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold">Library</h1>
            <p className="text-sm text-ink-dim">
              Your component library — every value carries its provenance.
            </p>
          </div>
          <button
            onClick={() => setAdding(true)}
            className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0"
          >
            Add component
          </button>
        </div>

        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search mpn, manufacturer, description…"
          className="mb-4 w-full rounded-md border border-line bg-surface-1 px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-accent-dim"
        />

        {components && components.length > 0 && (
          <p className="mb-3 text-xs text-ink-faint">
            {components.length === PAGE_SIZE
              ? `Showing the first ${PAGE_SIZE.toLocaleString()} — refine your search to narrow.`
              : `${components.length.toLocaleString()} ${components.length === 1 ? "component" : "components"}`}
          </p>
        )}

        {isLoading && <p className="text-sm text-ink-faint">Loading…</p>}

        {components?.length === 0 && (
          <div className="rounded-lg border border-dashed border-line p-10 text-center text-sm text-ink-faint">
            {q || category
              ? "No components match this filter."
              : "Library is empty. Bulk-import thousands of parts from the Sources tab, or add one by hand."}
          </div>
        )}

        {components && components.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-1 text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-2.5 font-medium">MPN</th>
                  <th className="px-4 py-2.5 font-medium">Manufacturer</th>
                  <th className="px-4 py-2.5 font-medium">Category</th>
                  <th className="px-4 py-2.5 font-medium">Lifecycle</th>
                  <th className="px-4 py-2.5 font-medium">Description</th>
                </tr>
              </thead>
              <tbody>
                {components.map((c) => (
                  <tr
                    key={c.id}
                    onClick={() =>
                      navigate({
                        to: "/library/components/$componentId",
                        params: { componentId: c.id },
                      })
                    }
                    className="cursor-pointer border-b border-line bg-surface-1 last:border-b-0 hover:bg-surface-2"
                  >
                    <td className="px-4 py-3 font-mono text-accent">{c.mpn}</td>
                    <td className="px-4 py-3 text-ink-dim">{c.manufacturer || "—"}</td>
                    <td className="px-4 py-3">
                      <CategoryBadge category={c.category} />
                    </td>
                    <td className="px-4 py-3">
                      <LifecycleBadge lifecycle={c.lifecycle} />
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 text-ink-dim">
                      {c.description || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {adding && <ComponentFormPanel onClose={() => setAdding(false)} />}
    </div>
  );
}
