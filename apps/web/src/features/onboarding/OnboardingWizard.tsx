import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LlmSettings, LlmProviderKind } from "@embedded/llm";
import { api, type LlmDetectResult, type PullLine } from "../../lib/api";
import { Button, Spinner, StatusDot, TextInput, type Tone } from "../../components/ui";

/**
 * First-run setup. One screen: scan the machine, then offer the working doors —
 * local (Ollama, with a one-click model download sized to the detected GPU),
 * Claude via an existing login, or any OpenAI-compatible endpoint. Nothing is
 * made active until it actually answers a health check, and finishing (or
 * skipping) records `onboarded` so this never nags twice.
 */
export function OnboardingWizard({ onFinish }: { onFinish: () => void }) {
  const qc = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["llm-settings"], queryFn: api.llm.getSettings });
  const detect = useQuery({
    queryKey: ["llm-detect"],
    queryFn: api.llm.detect,
    retry: false,
    refetchOnWindowFocus: false,
    staleTime: 0,
  });

  const [phase, setPhase] = useState<"choose" | "working" | "done">("choose");
  const [working, setWorking] = useState<string>("");
  const [pull, setPull] = useState<{ model: string; percent: number; status: string } | null>(null);
  const [outcome, setOutcome] = useState<{ ok: boolean; detail: string; provider: string } | null>(
    null,
  );
  const [apiOpen, setApiOpen] = useState(false);
  const [apiForm, setApiForm] = useState({ baseUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o" });
  const abortRef = useRef<AbortController | null>(null);

  const skip = useMutation({
    mutationFn: async () => {
      const base = settingsQuery.data;
      if (base) await api.llm.putSettings({ ...base, onboarded: true });
    },
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ["llm-settings"] });
      onFinish();
    },
  });

  function baseSettings(): LlmSettings | null {
    return settingsQuery.data ?? null;
  }

  /** Persist a provider's config, test it by kind, and only then make it active. */
  async function activate(
    kind: LlmProviderKind,
    patch: (s: LlmSettings) => LlmSettings,
    opts: { pullModels?: string[]; label: string },
  ) {
    const base = baseSettings();
    if (!base) return;
    setOutcome(null);
    setPhase("working");
    setWorking(opts.label);
    try {
      // 1. save this provider's config (without switching active yet)
      const configured = patch(base);
      await api.llm.putSettings(configured);

      // 2. download any missing local models, streaming progress
      if (opts.pullModels && opts.pullModels.length > 0) {
        setWorking("Downloading models");
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        await api.llm.pullModels(
          opts.pullModels,
          (line: PullLine) => {
            if (line.model && !line.done && !line.error) {
              setPull({
                model: line.model,
                percent: line.percent ?? 0,
                status: line.status ?? "",
              });
            }
            if (line.error) throw new Error(line.error);
          },
          ctrl.signal,
        );
        setPull(null);
        abortRef.current = null;
      }

      // 3. health-check the chosen provider
      setWorking("Testing " + opts.label);
      const health = await api.llm.health(kind);
      if (!health.ok) {
        setOutcome({ ok: false, detail: health.detail, provider: kind });
        setPhase("choose");
        return;
      }

      // 4. it works — make it active and mark setup complete
      await api.llm.putSettings({ ...configured, activeProvider: kind, onboarded: true });
      await qc.invalidateQueries({ queryKey: ["llm-settings"] });
      setOutcome({ ok: true, detail: health.detail, provider: kind });
      setPhase("done");
    } catch (err) {
      setPull(null);
      abortRef.current = null;
      setOutcome({
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
        provider: kind,
      });
      setPhase("choose");
    }
  }

  function cancelWork() {
    abortRef.current?.abort();
    abortRef.current = null;
    setPull(null);
    setPhase("choose");
    setWorking("");
  }

  const d = detect.data;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Set up AI"
    >
      <div className="max-h-[90vh] w-full max-w-xl overflow-auto rounded-xl border border-line bg-surface-1 shadow-2xl shadow-black/50">
        <div className="flex items-baseline justify-between gap-3 border-b border-line px-5 py-3.5">
          <div>
            <h1 className="text-sm font-semibold text-ink">Set up AI</h1>
            <p className="mt-0.5 text-[11px] text-ink-faint">
              Pick one. You can change it any time in Settings.
            </p>
          </div>
          <Button variant="subtle" size="sm" onClick={() => skip.mutate()} disabled={skip.isPending}>
            Skip for now
          </Button>
        </div>

        <div className="p-5">
          {detect.isLoading && (
            <div className="flex items-center gap-2 py-8 text-xs text-ink-dim">
              <Spinner /> Scanning your machine…
            </div>
          )}

          {detect.isError && (
            <div className="py-4 text-xs text-danger">
              Couldn&apos;t scan the machine. You can still choose a provider below.
              <div className="mt-2">
                <Button variant="ghost" size="sm" onClick={() => detect.refetch()}>
                  Retry scan
                </Button>
              </div>
            </div>
          )}

          {d && (
            <>
              <HardwareSummary d={d} />

              {phase === "working" && (
                <WorkingView working={working} pull={pull} onCancel={cancelWork} />
              )}

              {phase === "done" && outcome?.ok && (
                <DoneView provider={outcome.provider} detail={outcome.detail} onFinish={onFinish} />
              )}

              {phase === "choose" && (
                <div className="mt-4 flex flex-col gap-3">
                  {outcome && !outcome.ok && (
                    <div className="rounded-md border border-danger/40 bg-danger/5 p-3 text-[11px] text-danger">
                      <span className="font-medium">{providerLabel(outcome.provider)} didn&apos;t connect.</span>{" "}
                      {outcome.detail}
                    </div>
                  )}

                  <LocalDoor d={d} onActivate={activate} onRescan={() => detect.refetch()} />

                  <ClaudeDoor d={d} onActivate={activate} onRescan={() => detect.refetch()} />

                  <ApiDoor
                    open={apiOpen}
                    onToggle={() => setApiOpen((v) => !v)}
                    form={apiForm}
                    setForm={setApiForm}
                    onActivate={activate}
                  />
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---- machine summary ---------------------------------------------------- */

function HardwareSummary({ d }: { d: LlmDetectResult }) {
  const gpu = d.hardware.gpus.find((g) => g.vendor === "nvidia") ?? d.hardware.gpus[0];
  const gpuText = gpu
    ? `${gpu.name}${gpu.vramGb ? ` · ${gpu.vramGb} GB` : ""}`
    : "no dedicated GPU";
  return (
    <div className="rounded-md border border-line bg-surface-2 px-3 py-2 text-[11px] text-ink-dim">
      <span className="num">{gpuText}</span>
      <span className="text-ink-faint"> · </span>
      <span className="num">{d.hardware.cpu.cores} cores</span>
      <span className="text-ink-faint"> · </span>
      <span className="num">{d.hardware.ramGb} GB RAM</span>
    </div>
  );
}

/* ---- working / progress ------------------------------------------------- */

function WorkingView({
  working,
  pull,
  onCancel,
}: {
  working: string;
  pull: { model: string; percent: number; status: string } | null;
  onCancel: () => void;
}) {
  return (
    <div className="mt-4 rounded-md border border-line bg-surface-2 p-4">
      <div className="flex items-center gap-2 text-xs text-ink">
        <Spinner /> {working}…
      </div>
      {pull && (
        <div className="mt-3">
          <div className="mb-1 flex items-baseline justify-between text-[11px] text-ink-dim">
            <span className="num">{pull.model}</span>
            <span className="num">{pull.percent}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-0">
            <div
              className="h-full rounded-full bg-accent transition-[width] duration-200"
              style={{ width: `${pull.percent}%` }}
            />
          </div>
          <div className="mt-1 truncate text-[10px] text-ink-faint">{pull.status}</div>
        </div>
      )}
      <div className="mt-3">
        <Button variant="subtle" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function DoneView({
  provider,
  detail,
  onFinish,
}: {
  provider: string;
  detail: string;
  onFinish: () => void;
}) {
  return (
    <div className="mt-4 rounded-md border border-ok/40 bg-ok/5 p-4">
      <div className="flex items-center gap-2 text-sm font-medium text-ok">
        <StatusDot tone="ok" /> {providerLabel(provider)} is ready.
      </div>
      <p className="mt-1 text-[11px] text-ink-dim">{detail}</p>
      <div className="mt-3 flex justify-end">
        <Button variant="primary" size="md" onClick={onFinish}>
          Start building
        </Button>
      </div>
    </div>
  );
}

/* ---- doors -------------------------------------------------------------- */

type Activate = (
  kind: LlmProviderKind,
  patch: (s: LlmSettings) => LlmSettings,
  opts: { pullModels?: string[]; label: string },
) => void;

function DoorShell({
  title,
  tone,
  recommended,
  status,
  children,
}: {
  title: string;
  tone: Tone;
  recommended?: boolean;
  status: string;
  children: React.ReactNode;
}) {
  return (
    <section
      className={
        "rounded-lg border p-4 " +
        (recommended ? "border-accent-dim bg-surface-2" : "border-line bg-surface-1")
      }
    >
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <StatusDot tone={tone} />
          <span className="text-sm font-semibold text-ink">{title}</span>
          {recommended && (
            <span className="rounded border border-accent-dim px-1.5 py-0.5 text-[9px] font-medium uppercase tracking-wide text-accent">
              recommended
            </span>
          )}
        </div>
        <span className="text-[10px] text-ink-faint">{status}</span>
      </div>
      {children}
    </section>
  );
}

function LocalDoor({
  d,
  onActivate,
  onRescan,
}: {
  d: LlmDetectResult;
  onActivate: Activate;
  onRescan: () => void;
}) {
  const rec = d.recommendation;
  const { cliInstalled, serverRunning } = d.ollama;
  const ready = serverRunning;
  const tone: Tone = ready ? "accent" : cliInstalled ? "warn" : "muted";
  const recommended = ready;

  const activateLocal = () =>
    onActivate(
      "ollama",
      (s) => ({ ...s, ollama: { ...s.ollama, models: rec.models } }),
      {
        label: "Local models",
        ...(rec.missingModels.length > 0 ? { pullModels: rec.missingModels } : {}),
      },
    );

  return (
    <DoorShell
      title="Run locally"
      tone={tone}
      recommended={recommended}
      status={serverRunning ? `Ollama ${d.ollama.serverVersion ?? ""}` : cliInstalled ? "Ollama installed" : "Ollama not found"}
    >
      <p className="text-[11px] leading-relaxed text-ink-dim">
        Private and free — datasheets never leave this machine. {rec.note}
      </p>

      {ready ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[11px] text-ink-faint">
            {rec.alreadyInstalled ? (
              <>Models ready: <span className="num">{rec.uniqueModels.join(", ")}</span></>
            ) : (
              <>
                Will download <span className="num">{rec.uniqueModels.join(", ")}</span>{" "}
                (~<span className="num">{rec.downloadGb} GB</span>)
              </>
            )}
          </span>
          <Button variant="primary" size="md" onClick={activateLocal}>
            {rec.alreadyInstalled ? "Use local models" : "Download & use"}
          </Button>
        </div>
      ) : cliInstalled ? (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[11px] text-warn">
            Ollama is installed but not running. Start it, then re-scan.
          </span>
          <Button variant="ghost" size="sm" onClick={onRescan}>
            Re-scan
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[11px] text-ink-faint">
            Install Ollama from{" "}
            <a
              href="https://ollama.com/download"
              target="_blank"
              rel="noreferrer"
              className="text-accent underline"
            >
              ollama.com/download
            </a>
            , then re-scan.
          </span>
          <Button variant="ghost" size="sm" onClick={onRescan}>
            Re-scan
          </Button>
        </div>
      )}
    </DoorShell>
  );
}

function ClaudeDoor({
  d,
  onActivate,
  onRescan,
}: {
  d: LlmDetectResult;
  onActivate: Activate;
  onRescan: () => void;
}) {
  const installed = d.claudeCode.cliInstalled;
  return (
    <DoorShell
      title="Use Claude"
      tone={installed ? "accent" : "muted"}
      status={installed ? `Claude Code ${d.claudeCode.cliVersion ?? ""}` : "Claude Code not found"}
    >
      <p className="text-[11px] leading-relaxed text-ink-dim">
        Strongest models, nothing to download. Uses your existing Claude Code login — billed to your
        Claude subscription, no API key.
      </p>
      {installed ? (
        <div className="mt-3 flex justify-end">
          <Button
            variant="ghost"
            size="md"
            onClick={() => onActivate("claude-code", (s) => s, { label: "Claude" })}
          >
            Use Claude
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-[11px] text-ink-faint">
            Install Claude Code and run <code className="font-mono text-ink-dim">claude login</code>, then
            re-scan.
          </span>
          <Button variant="ghost" size="sm" onClick={onRescan}>
            Re-scan
          </Button>
        </div>
      )}
    </DoorShell>
  );
}

function ApiDoor({
  open,
  onToggle,
  form,
  setForm,
  onActivate,
}: {
  open: boolean;
  onToggle: () => void;
  form: { baseUrl: string; apiKey: string; model: string };
  setForm: (f: { baseUrl: string; apiKey: string; model: string }) => void;
  onActivate: Activate;
}) {
  return (
    <DoorShell title="Use an API provider" tone="muted" status="OpenAI-compatible">
      <p className="text-[11px] leading-relaxed text-ink-dim">
        Any <span className="font-mono">/chat/completions</span> endpoint — OpenAI, OpenRouter, LM
        Studio, vLLM…
      </p>
      {!open ? (
        <div className="mt-3 flex justify-end">
          <Button variant="ghost" size="sm" onClick={onToggle}>
            Configure
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <TextInput
            placeholder="Base URL"
            value={form.baseUrl}
            onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
          />
          <div className="flex gap-2">
            <TextInput
              type="password"
              placeholder="API key"
              value={form.apiKey}
              onChange={(e) => setForm({ ...form, apiKey: e.target.value })}
              className="flex-[2]"
            />
            <TextInput
              placeholder="Model"
              value={form.model}
              onChange={(e) => setForm({ ...form, model: e.target.value })}
              className="flex-1"
              mono
            />
          </div>
          <div className="flex justify-end">
            <Button
              variant="primary"
              size="md"
              disabled={!form.baseUrl || !form.model}
              onClick={() =>
                onActivate(
                  "openai-compat",
                  (s) => ({
                    ...s,
                    openaiCompat: {
                      ...s.openaiCompat,
                      baseUrl: form.baseUrl,
                      apiKey: form.apiKey,
                      models: { triage: form.model, extraction: form.model, assistant: form.model },
                    },
                  }),
                  { label: "API provider" },
                )
              }
            >
              Connect
            </Button>
          </div>
        </div>
      )}
    </DoorShell>
  );
}

function providerLabel(kind: string): string {
  if (kind === "ollama") return "Local models";
  if (kind === "claude-code") return "Claude";
  if (kind === "openai-compat") return "API provider";
  return kind;
}
