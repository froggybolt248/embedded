import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type SimulateEvent } from "../../lib/api";
import { Button } from "../../components/ui";

/**
 * The Simulate phase: run the design's firmware on a simulated board before
 * any hardware exists or money is spent.
 *
 * The panel stands on three capability legs and shows each one honestly:
 * a simulatable MCU in the design, the Renode simulator (a one-time ~112 MB
 * download, MIT-licensed, works offline afterwards), and PlatformIO to build
 * the firmware. A leg that is missing gets guidance, never a dead button —
 * the same capability-gating rule Bring-up uses for probe-rs.
 *
 * A run streams its whole transcript: build output, the exact Monitor
 * commands sent to Renode, live UART bytes, LED samples. A simulation you
 * can replay by hand is auditable; a spinner that ends in "success" is not.
 */
export function SimulatePanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const { data: cap } = useQuery({
    queryKey: ["simulate-capability", projectId],
    queryFn: () => api.simulate.capability(projectId),
  });

  const [downloading, setDownloading] = useState(false);
  const [downloadPct, setDownloadPct] = useState(0);
  const [running, setRunning] = useState(false);
  const [transcript, setTranscript] = useState<string[]>([]);
  const [uart, setUart] = useState("");
  const [led, setLed] = useState<string[]>([]);
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const uartRef = useRef<HTMLPreElement | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    // follow the newest serial output, the way a terminal does
    uartRef.current?.scrollTo({ top: uartRef.current.scrollHeight });
  }, [uart]);

  const appendLine = (s: string) => setTranscript((t) => [...t.slice(-199), s]);

  async function downloadSimulator() {
    setDownloading(true);
    setOutcome(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await api.simulate.downloadRenode((line) => {
        if (line.event === "progress" && line.receivedBytes !== undefined && line.totalBytes) {
          setDownloadPct(Math.round((line.receivedBytes / line.totalBytes) * 100));
        }
        if (line.event === "error") throw new Error(line.error);
      }, ctrl.signal);
      await qc.invalidateQueries({ queryKey: ["simulate-capability", projectId] });
    } catch (err) {
      setOutcome({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setDownloading(false);
    }
  }

  async function run() {
    setRunning(true);
    setTranscript([]);
    setUart("");
    setLed([]);
    setOutcome(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await api.simulate.run(
        projectId,
        (line: SimulateEvent) => {
          switch (line.event) {
            case "phase":
              appendLine(`── ${line.phase} ──`);
              break;
            case "build-output":
              if (line.chunk) appendLine(line.chunk.trimEnd());
              break;
            case "built":
              appendLine(`firmware built: ${line.elfPath ?? ""}`);
              break;
            case "monitor":
              appendLine(`(monitor) ${line.command ?? ""}`);
              break;
            case "monitor-output":
              if (line.output) appendLine(line.output.trim());
              break;
            case "uart":
              setUart((u) => (u + (line.chunk ?? "")).slice(-4000));
              break;
            case "led":
              setLed((l) => [...l, line.state ?? "?"]);
              break;
            case "done":
              setOutcome({
                ok: line.ledBlinked === true,
                text:
                  line.ledBlinked === true
                    ? "Firmware ran: UART is talking and the LED is blinking — the core is executing, not merely loaded."
                    : "The firmware loaded, but the LED never changed state — check the UART output above for why.",
              });
              break;
            case "error":
              setOutcome({ ok: false, text: line.error ?? "simulation failed" });
              break;
          }
        },
        ctrl.signal,
      );
    } catch (err) {
      setOutcome({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setRunning(false);
    }
  }

  const legs = cap
    ? [
        {
          label: "Simulatable MCU",
          ok: cap.target.supported,
          detail: cap.target.supported
            ? `${cap.target.mpn} → simulated as ${cap.target.boardName}`
            : (cap.target.detail ?? "") + ` — supported today: ${cap.supportedBoards.join(", ")}`,
        },
        {
          label: "Renode simulator",
          ok: cap.renode.present,
          detail: cap.renode.detail ?? "",
          action: !cap.renode.present ? (
            <Button variant="primary" size="sm" onClick={() => void downloadSimulator()} disabled={downloading}>
              {downloading ? `Downloading… ${downloadPct}%` : "Download simulator (112 MB)"}
            </Button>
          ) : undefined,
        },
        {
          label: "PlatformIO build tool",
          ok: cap.platformio.present,
          detail: cap.platformio.present
            ? (cap.platformio.detail ?? "installed")
            : "not installed — install PlatformIO Core from platformio.org/install/cli (external tool, spawned, never bundled)",
        },
      ]
    : [];

  const allLegs = legs.length > 0 && legs.every((l) => l.ok);

  return (
    <section className="rounded-lg border border-line bg-surface-1">
      <h2 className="border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        Simulate
      </h2>

      <div className="space-y-2 px-4 py-3">
        {legs.map((leg) => (
          <div key={leg.label} className="flex items-start justify-between gap-3 rounded border border-line bg-surface-2 px-3 py-2">
            <div className="min-w-0">
              <p className="text-xs font-medium text-ink">
                <span className={leg.ok ? "text-ok" : "text-warn"}>{leg.ok ? "●" : "○"}</span> {leg.label}
              </p>
              <p className="mt-0.5 text-[11px] text-ink-dim">{leg.detail}</p>
            </div>
            {leg.action}
          </div>
        ))}
      </div>

      <div className="border-t border-line px-4 py-3">
        <Button variant="primary" size="md" onClick={() => void run()} disabled={!allLegs || running}>
          {running ? "Simulating…" : "Build & run in simulator"}
        </Button>
        {!allLegs && cap && (
          <span className="ml-3 text-[11px] text-ink-faint">
            enabled once every leg above is standing — no dead buttons
          </span>
        )}
      </div>

      {(transcript.length > 0 || uart.length > 0) && (
        <div className="grid gap-3 border-t border-line px-4 py-3 lg:grid-cols-2">
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-widest text-ink-faint">build + monitor transcript</p>
            <pre className="num h-48 overflow-auto rounded border border-line bg-surface-0 p-2 text-[10px] leading-relaxed text-ink-dim">
              {transcript.join("\n")}
            </pre>
          </div>
          <div>
            <p className="mb-1 text-[10px] uppercase tracking-widest text-ink-faint">
              uart0 (live){led.length > 0 ? ` · led0: ${led.join(" → ")}` : ""}
            </p>
            <pre
              ref={uartRef}
              className="num h-48 overflow-auto rounded border border-line bg-surface-0 p-2 text-[10px] leading-relaxed text-ink"
            >
              {uart || "— no serial output yet —"}
            </pre>
          </div>
        </div>
      )}

      {outcome && (
        <p
          className={`border-t border-line px-4 py-3 text-xs ${outcome.ok ? "text-ok" : "text-warn"}`}
        >
          {outcome.text}
        </p>
      )}
    </section>
  );
}
