import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { api } from "../../lib/api";
import { LibraryTabs } from "../library/LibraryTabs";

export function DatasheetsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { data: datasheets, isLoading } = useQuery({
    queryKey: ["datasheets"],
    queryFn: api.datasheets.list,
  });

  const upload = useMutation({
    mutationFn: (file: File) => api.datasheets.upload(file),
    onSuccess: (datasheet) => {
      qc.invalidateQueries({ queryKey: ["datasheets"] });
      navigate({ to: "/library/datasheets/$datasheetId", params: { datasheetId: datasheet.id } });
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.datasheets.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["datasheets"] }),
  });

  function handleFile(file: File | undefined) {
    if (!file) return;
    setError(null);
    upload.mutate(file);
  }

  return (
    <div className="p-8">
      <LibraryTabs />
      <div className="mb-6 flex items-center justify-between gap-4">
        <div>
          <h1 className="text-xl font-semibold">Datasheets</h1>
          <p className="text-sm text-ink-dim">
            Upload a datasheet PDF, then extract specs with citations.
          </p>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={upload.isPending}
          className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 transition-opacity disabled:opacity-40"
        >
          {upload.isPending ? "Uploading…" : "Upload datasheet"}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="application/pdf"
          className="hidden"
          onChange={(e) => {
            handleFile(e.target.files?.[0]);
            e.target.value = "";
          }}
        />
      </div>

      {error && (
        <div className="mb-4 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
          {error}
        </div>
      )}

      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          handleFile(e.dataTransfer.files?.[0]);
        }}
        className={`rounded-lg border transition-colors ${
          dragOver ? "border-accent bg-accent/5" : "border-transparent"
        }`}
      >
        {isLoading && <p className="text-sm text-ink-faint">Loading…</p>}

        {datasheets?.length === 0 && (
          <div
            className={`rounded-lg border border-dashed p-10 text-center text-sm text-ink-faint ${
              dragOver ? "border-accent text-accent" : "border-line"
            }`}
          >
            {dragOver
              ? "Drop to upload"
              : "No datasheets yet. Upload a PDF, or drag one in here."}
          </div>
        )}

        {datasheets && datasheets.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line bg-surface-1 text-left text-[11px] uppercase tracking-wide text-ink-faint">
                  <th className="px-4 py-2.5 font-medium">Filename</th>
                  <th className="px-4 py-2.5 font-medium">Pages</th>
                  <th className="px-4 py-2.5 font-medium">Component</th>
                  <th className="px-4 py-2.5 font-medium">Created</th>
                  <th className="px-4 py-2.5 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {datasheets.map((d) => (
                  <tr
                    key={d.id}
                    onClick={() =>
                      navigate({
                        to: "/library/datasheets/$datasheetId",
                        params: { datasheetId: d.id },
                      })
                    }
                    className="cursor-pointer border-b border-line bg-surface-1 last:border-b-0 hover:bg-surface-2"
                  >
                    <td className="px-4 py-3 font-mono text-accent">{d.filename}</td>
                    <td className="num px-4 py-3 text-ink-dim">{d.pageCount}</td>
                    <td className="px-4 py-3">
                      {d.componentId ? (
                        <Link
                          to="/library/components/$componentId"
                          params={{ componentId: d.componentId }}
                          onClick={(e) => e.stopPropagation()}
                          className="text-accent hover:underline"
                        >
                          view component
                        </Link>
                      ) : (
                        <span className="text-ink-faint">—</span>
                      )}
                    </td>
                    <td className="num px-4 py-3 text-xs text-ink-faint">
                      {new Date(d.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (window.confirm(`Delete ${d.filename}?`)) remove.mutate(d.id);
                        }}
                        disabled={remove.isPending}
                        className="rounded px-2 py-1 text-xs text-ink-faint hover:text-danger disabled:opacity-40"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
