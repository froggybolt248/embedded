import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type KicadImportJob } from "../../lib/api";
import { LibraryTabs } from "./LibraryTabs";

const isRunning = (s: KicadImportJob["status"]) => s === "cloning" || s === "importing";

function SummaryStat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border border-line bg-surface-1 px-3 py-2">
      <div className="num text-lg font-semibold text-ink">{value.toLocaleString()}</div>
      <div className="text-[11px] uppercase tracking-wide text-ink-faint">{label}</div>
    </div>
  );
}

export function SourcesPage() {
  const qc = useQueryClient();

  const { data: job } = useQuery({
    queryKey: ["kicad-status"],
    queryFn: api.kicad.status,
    refetchInterval: (query) => (isRunning(query.state.data?.status ?? "idle") ? 700 : false),
  });

  const start = useMutation({
    mutationFn: (body: { limit?: number }) => api.kicad.import(body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["kicad-status"] });
    },
  });

  // once an import finishes, the component library has changed underneath us
  const status = job?.status ?? "idle";
  useEffect(() => {
    if (status === "done") {
      qc.invalidateQueries({ queryKey: ["components"] });
      qc.invalidateQueries({ queryKey: ["component-stats"] });
    }
  }, [status, qc]);

  const running = isRunning(status);
  const pct = job?.total && job.total > 0 ? Math.round(((job.done ?? 0) / job.total) * 100) : null;

  return (
    <div className="mx-auto max-w-3xl p-8">
      <LibraryTabs />
      <div className="mb-6">
        <h1 className="text-xl font-semibold">Sources</h1>
        <p className="text-sm text-ink-dim">
          Seed your library in bulk, then deepen the parts you actually use from their datasheets.
        </p>
      </div>

      <section className="rounded-lg border border-line bg-surface-1 p-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="font-medium text-ink">KiCad symbol library</h2>
            <p className="mt-1 max-w-xl text-sm text-ink-dim">
              ~23,000 permissively-licensed parts, each with pin names, numbers and functions — the
              hardest thing to recover from a PDF — plus a datasheet URL to deepen later. Derived
              symbols import as family variants. The library is cloned locally with <code className="font-mono text-xs text-ink">git</code>; re-running updates it.
            </p>
          </div>
        </div>

        <div className="mt-4 flex gap-2">
          <button
            onClick={() => start.mutate({})}
            disabled={running || start.isPending}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 transition-opacity disabled:opacity-40"
          >
            {running ? "Importing…" : "Import full library"}
          </button>
          <button
            onClick={() => start.mutate({ limit: 1000 })}
            disabled={running || start.isPending}
            className="rounded-md border border-line px-4 py-2 text-sm text-ink-dim hover:border-accent-dim hover:text-ink disabled:opacity-40"
          >
            Import a sample (1,000)
          </button>
        </div>

        {start.isError && (
          <div className="mt-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {start.error instanceof Error ? start.error.message : String(start.error)}
          </div>
        )}

        {job && status !== "idle" && (
          <div className="mt-5 border-t border-line pt-4">
            {status === "cloning" && (
              <div className="flex items-center gap-3 text-sm text-ink-dim">
                <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                Cloning KiCad library — <span className="num text-ink-faint">{job.detail}</span>
              </div>
            )}

            {status === "importing" && (
              <div>
                <div className="mb-1.5 flex items-center justify-between text-xs text-ink-dim">
                  <span>
                    Importing <span className="font-mono text-ink">{job.detail}</span>
                  </span>
                  <span className="num text-ink-faint">
                    {job.done}/{job.total} libraries{pct !== null ? ` · ${pct}%` : ""}
                  </span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
                  <div
                    className="h-full rounded-full bg-accent transition-all"
                    style={{ width: `${pct ?? 0}%` }}
                  />
                </div>
              </div>
            )}

            {status === "failed" && (
              <div className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
                Import failed: {job.error}
              </div>
            )}

            {status === "done" && job.summary && (
              <div>
                <p className="mb-3 text-sm text-ok">✓ {job.detail}</p>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  <SummaryStat label="Created" value={job.summary.created} />
                  <SummaryStat label="Family variants" value={job.summary.variantsLinked} />
                  <SummaryStat label="Libraries" value={job.summary.librariesProcessed} />
                  <SummaryStat label="Symbols read" value={job.summary.symbolsFound} />
                  <SummaryStat label="Already present" value={job.summary.skippedDuplicates} />
                  <SummaryStat label="Unreadable files" value={job.summary.failedFiles} />
                </div>
              </div>
            )}
          </div>
        )}
      </section>

      <section className="mt-4 rounded-lg border border-dashed border-line p-5 text-sm text-ink-faint">
        <h2 className="font-medium text-ink-dim">Datasheet ingest</h2>
        <p className="mt-1">
          For grounded electrical specs — abs-max, currents, timings — upload a datasheet on the{" "}
          <span className="text-ink-dim">Datasheets</span> tab. The free deterministic pass reads
          most tables with no model call; vision fills only what it can't.
        </p>
      </section>
    </div>
  );
}
