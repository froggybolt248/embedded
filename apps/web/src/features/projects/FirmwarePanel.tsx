import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, type FirmwareFile } from "../../lib/api";

/** Blob → temporary <a download> → click → revoke. No zip dependency. */
function downloadFile(file: FirmwareFile): void {
  const blob = new Blob([file.content], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function FileRow({ file }: { file: FirmwareFile }) {
  const [open, setOpen] = useState(false);

  return (
    <li className="border-b border-line/60 px-4 py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
        >
          <span className="shrink-0 text-ink-faint">{open ? "▾" : "▸"}</span>
          <span className="truncate font-mono text-xs text-ink">{file.name}</span>
          <span className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-faint">
            {file.kind}
          </span>
        </button>
        <button
          onClick={() => downloadFile(file)}
          className="shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:text-ink"
        >
          download
        </button>
      </div>

      {open && (
        <pre className="num mt-2 max-h-72 overflow-auto rounded border border-line bg-surface-2 p-2.5 font-mono text-xs text-ink-dim">
          {file.content}
        </pre>
      )}
    </li>
  );
}

/**
 * Firmware generation — placeholder UI, thin on purpose. The server derives
 * pins.h and platformio.ini deterministically from the design; nothing is
 * persisted, so the button re-fetches every time the design has moved on.
 *
 * pins.h deliberately contains valueless #defines and a compile-blocking
 * #error when the design has no pin numbers assigned — that is honest
 * behavior, not a bug, and this panel never hides or strips it.
 */
export function FirmwarePanel({ projectId }: { projectId: string }) {
  const [enabled, setEnabled] = useState(false);

  const { data, isFetching, isError, error, refetch } = useQuery({
    queryKey: ["firmware", projectId],
    queryFn: () => api.firmware.generate(projectId),
    enabled,
  });

  const files = data?.files ?? [];

  const onGenerate = () => {
    if (enabled) {
      void refetch();
    } else {
      setEnabled(true);
    }
  };

  return (
    <section className="rounded-lg border border-line bg-surface-1">
      <h2 className="border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        Firmware
      </h2>

      <div className="flex items-center justify-between gap-3 border-b border-line px-4 py-3">
        <p className="text-[11px] text-ink-faint">
          Pin numbers aren't assigned yet — the header blocks compilation until you fill them in,
          instead of guessing.
        </p>
        <button
          onClick={onGenerate}
          disabled={isFetching}
          className="shrink-0 rounded bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 disabled:opacity-40"
        >
          {isFetching ? "generating…" : enabled ? "regenerate" : "Generate files"}
        </button>
      </div>

      {isError && (
        <div className="border-b border-line px-4 py-2 text-[11px] text-danger">
          {error instanceof Error ? error.message : "Failed to generate firmware."}
        </div>
      )}

      {enabled && !isFetching && files.length === 0 && !isError && (
        <p className="px-4 py-6 text-center text-xs text-ink-faint">
          No files were generated for this design.
        </p>
      )}

      {files.length > 0 && (
        <>
          <ul>
            {files.map((f) => (
              <FileRow key={f.name} file={f} />
            ))}
          </ul>
          <div className="border-t border-line px-4 py-3">
            <button
              onClick={() => files.forEach(downloadFile)}
              className="rounded border border-line px-3 py-1.5 text-xs font-medium text-ink-dim hover:text-ink"
            >
              Download all
            </button>
          </div>
        </>
      )}
    </section>
  );
}
