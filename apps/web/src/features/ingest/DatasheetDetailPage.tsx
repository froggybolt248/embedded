import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { api } from "../../lib/api";
import { StatusBadge } from "./badges";

export function DatasheetDetailPage() {
  const { datasheetId } = useParams({ from: "/library/datasheets/$datasheetId" });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [page, setPage] = useState(1);

  const { data: datasheet, isLoading, isError } = useQuery({
    queryKey: ["datasheet", datasheetId],
    queryFn: () => api.datasheets.get(datasheetId),
  });

  const { data: runs } = useQuery({
    queryKey: ["datasheet-runs", datasheetId],
    queryFn: () => api.datasheets.runs(datasheetId),
  });

  const extract = useMutation({
    mutationFn: (mode: "hybrid" | "deterministic") => api.datasheets.extract(datasheetId, mode),
    onSuccess: (run) => {
      qc.invalidateQueries({ queryKey: ["datasheet-runs", datasheetId] });
      navigate({ to: "/library/runs/$runId", params: { runId: run.id } });
    },
  });

  if (isLoading) {
    return <p className="p-8 text-sm text-ink-faint">Loading…</p>;
  }
  if (isError || !datasheet) {
    return (
      <div className="p-8">
        <p className="text-sm text-danger">Datasheet not found.</p>
        <Link to="/library/datasheets" className="text-sm text-accent hover:underline">
          ← Back to datasheets
        </Link>
      </div>
    );
  }

  const pageCount = datasheet.pageCount;
  const clampedPage = Math.min(Math.max(page, 1), pageCount);

  return (
    <div className="mx-auto max-w-5xl p-8">
      <Link
        to="/library/datasheets"
        className="mb-4 inline-block text-xs text-ink-faint hover:text-accent"
      >
        ← Datasheets
      </Link>

      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-mono text-xl font-semibold text-ink">{datasheet.filename}</h1>
          <p className="num mt-1 text-xs text-ink-faint">
            {pageCount} page{pageCount === 1 ? "" : "s"} ·{" "}
            <span title={datasheet.sha256}>{datasheet.sha256.slice(0, 12)}</span>
          </p>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <div className="flex gap-2">
            <button
              onClick={() => extract.mutate("deterministic")}
              disabled={extract.isPending}
              title="Tier 0 + Tier 1 only — reads tables off the text layer with no model call"
              className="rounded-md border border-line px-3 py-2 text-sm text-ink-dim hover:border-accent-dim hover:text-ink disabled:opacity-40"
            >
              {extract.isPending ? "Starting…" : "Fast extract (free)"}
            </button>
            <button
              onClick={() => extract.mutate("hybrid")}
              disabled={extract.isPending}
              title="Free pass first, then the vision model only on pages it could not read"
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 transition-opacity disabled:opacity-40"
            >
              {extract.isPending ? "Starting…" : "Full extract"}
            </button>
          </div>
        </div>
      </div>

      {extract.isError && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {extract.error instanceof Error ? extract.error.message : String(extract.error)}
        </div>
      )}

      <div className="mb-8 flex flex-col items-center gap-3 rounded-lg border border-line bg-surface-1 p-4">
        <img
          src={api.datasheets.pageUrl(datasheetId, clampedPage)}
          alt={`Page ${clampedPage}`}
          className="max-h-[32rem] rounded border border-line bg-surface-0 object-contain"
        />
        <div className="flex items-center gap-3">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={clampedPage <= 1}
            className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-dim hover:border-accent-dim hover:text-ink disabled:opacity-40"
          >
            ← prev
          </button>
          <span className="num text-xs text-ink-faint">
            page {clampedPage} / {pageCount}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(pageCount, p + 1))}
            disabled={clampedPage >= pageCount}
            className="rounded-md border border-line px-2.5 py-1 text-xs text-ink-dim hover:border-accent-dim hover:text-ink disabled:opacity-40"
          >
            next →
          </button>
        </div>
      </div>

      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        Extraction runs
      </h2>
      {!runs || runs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line p-8 text-center text-sm text-ink-faint">
          No extraction runs yet. Extract specs to get started.
        </div>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line bg-surface-1 text-left text-[11px] uppercase tracking-wide text-ink-faint">
                <th className="px-4 py-2.5 font-medium">Created</th>
                <th className="px-4 py-2.5 font-medium">Model</th>
                <th className="px-4 py-2.5 font-medium">Prompt</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((run) => (
                <tr
                  key={run.id}
                  onClick={() => navigate({ to: "/library/runs/$runId", params: { runId: run.id } })}
                  className="cursor-pointer border-b border-line bg-surface-1 last:border-b-0 hover:bg-surface-2"
                >
                  <td className="num px-4 py-3 text-xs text-ink-faint">
                    {new Date(run.createdAt).toLocaleString()}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-dim">{run.model}</td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-dim">{run.promptVersion}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={run.status} />
                  </td>
                  <td
                    className="max-w-xs truncate px-4 py-3 text-xs text-danger"
                    {...(run.error ? { title: run.error } : {})}
                  >
                    {run.error ?? ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
