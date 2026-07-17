import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { LlmSettings, LlmProviderKind, ModelTier } from "@embedded/llm";
import { api, type LlmExtractTestResult, type LlmHealthResult, type OllamaModelInfo } from "../../lib/api";

const TIERS: ModelTier[] = ["triage", "extraction", "assistant"];
const TIER_HINTS: Record<ModelTier, string> = {
  triage: "cheap + fast — page classification, quick checks",
  extraction: "strongest — datasheet field extraction",
  assistant: "phase assists — quantify, propose, draft",
};

const inputClass =
  "w-full rounded-md border border-line bg-surface-1 px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-accent-dim";
const labelClass = "mb-1 block text-xs font-medium text-ink-dim";

interface TestState {
  running: boolean;
  startedAt?: number;
  health?: LlmHealthResult;
  extract?: LlmExtractTestResult;
  error?: string;
}

export function SettingsPage() {
  const qc = useQueryClient();
  const settingsQuery = useQuery({ queryKey: ["llm-settings"], queryFn: api.llm.getSettings });
  const ollamaModelsQuery = useQuery({
    queryKey: ["ollama-models"],
    queryFn: api.llm.ollamaModels,
    retry: false,
  });

  const [draft, setDraft] = useState<LlmSettings | null>(null);
  const [tests, setTests] = useState<Partial<Record<LlmProviderKind, TestState>>>({});
  useEffect(() => {
    if (settingsQuery.data && !draft) setDraft(settingsQuery.data);
  }, [settingsQuery.data, draft]);

  const save = useMutation({
    mutationFn: api.llm.putSettings,
    onSuccess: (saved) => {
      qc.setQueryData(["llm-settings"], saved);
      setDraft(saved);
    },
  });

  async function runTest(kind: LlmProviderKind) {
    setTests((t) => ({ ...t, [kind]: { running: true, startedAt: Date.now() } }));
    try {
      if (draft) await api.llm.putSettings(draft); // test what's on screen
      const health = await api.llm.health(kind);
      let extract: LlmExtractTestResult | undefined;
      if (health.ok) {
        try {
          extract = await api.llm.extractTest(kind);
        } catch (err) {
          extract = {
            provider: kind,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      }
      setTests((t) => ({ ...t, [kind]: { running: false, health, ...(extract ? { extract } : {}) } }));
    } catch (err) {
      setTests((t) => ({
        ...t,
        [kind]: { running: false, error: err instanceof Error ? err.message : String(err) },
      }));
    }
  }

  if (settingsQuery.isLoading || !draft) {
    return <div className="p-8 text-sm text-ink-faint">Loading settings…</div>;
  }

  const dirty = JSON.stringify(draft) !== JSON.stringify(settingsQuery.data);

  return (
    <div className="mx-auto max-w-3xl p-8">
      <h1 className="mb-1 text-xl font-semibold">Settings</h1>
      <p className="mb-6 text-sm text-ink-dim">
        LLM providers. Numbers in this app are never freehanded by a model — the LLM only
        classifies, extracts with citations, and drafts; calculators and your reviewed library
        supply the values.
      </p>

      <div className="flex flex-col gap-4">
        <ProviderCard
          kind="ollama"
          title="Ollama"
          badge="default"
          subtitle="Fully local and free — datasheets never leave this machine. Extraction needs a vision model."
          active={draft.activeProvider === "ollama"}
          onActivate={() => setDraft({ ...draft, activeProvider: "ollama" })}
          onTest={() => runTest("ollama")}
          test={tests["ollama"]}
        >
          <div className="mb-3 flex gap-3">
            <div className="flex-[2]">
              <label className={labelClass}>Base URL</label>
              <input
                value={draft.ollama.baseUrl}
                onChange={(e) =>
                  setDraft({ ...draft, ollama: { ...draft.ollama, baseUrl: e.target.value } })
                }
                className={`${inputClass} font-mono`}
              />
            </div>
            <div className="flex-1">
              <label className={labelClass}>
                Context size <span className="font-normal text-ink-faint">— num_ctx</span>
              </label>
              <input
                type="number"
                value={draft.ollama.numCtx}
                min={2048}
                max={131072}
                step={2048}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    ollama: { ...draft.ollama, numCtx: Number(e.target.value) },
                  })
                }
                className={`${inputClass} num`}
              />
            </div>
            <div className="flex-1">
              <label className={labelClass}>
                Request timeout <span className="font-normal text-ink-faint">— seconds</span>
              </label>
              <input
                type="number"
                value={draft.ollama.requestTimeoutSec}
                min={30}
                max={3600}
                step={30}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    ollama: { ...draft.ollama, requestTimeoutSec: Number(e.target.value) },
                  })
                }
                className={`${inputClass} num`}
              />
            </div>
          </div>
          <p className="mb-3 text-xs text-ink-faint">
            Ollama defaults to a 4096 context, which one page-image extraction request overruns —
            lower it if you run out of VRAM. Local vision is slow (90–300 s per request on a laptop
            GPU), so the timeout is deliberately generous.
          </p>
          <OllamaTierModelInputs
            models={draft.ollama.models}
            onChange={(models) => setDraft({ ...draft, ollama: { ...draft.ollama, models } })}
            installed={ollamaModelsQuery.isSuccess ? ollamaModelsQuery.data : undefined}
          />
        </ProviderCard>

        <ProviderCard
          kind="claude-code"
          title="Claude (via Claude Code)"
          subtitle="Fallback for work the local models can't carry. Reuses your Claude Code login — billed to your Claude subscription, no API key."
          active={draft.activeProvider === "claude-code"}
          onActivate={() => setDraft({ ...draft, activeProvider: "claude-code" })}
          onTest={() => runTest("claude-code")}
          test={tests["claude-code"]}
        >
          <TierModelInputs
            models={draft.claudeCode.models}
            onChange={(models) =>
              setDraft({ ...draft, claudeCode: { ...draft.claudeCode, models } })
            }
          />
        </ProviderCard>

        <ProviderCard
          kind="openai-compat"
          title="OpenAI-compatible"
          subtitle="Any /chat/completions server: OpenAI, OpenRouter, LM Studio, llama.cpp, vLLM…"
          active={draft.activeProvider === "openai-compat"}
          onActivate={() => setDraft({ ...draft, activeProvider: "openai-compat" })}
          onTest={() => runTest("openai-compat")}
          test={tests["openai-compat"]}
        >
          <div className="mb-3 flex gap-3">
            <div className="flex-[2]">
              <label className={labelClass}>Base URL</label>
              <input
                value={draft.openaiCompat.baseUrl}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    openaiCompat: { ...draft.openaiCompat, baseUrl: e.target.value },
                  })
                }
                className={`${inputClass} font-mono`}
              />
            </div>
            <div className="flex-1">
              <label className={labelClass}>API key</label>
              <input
                type="password"
                value={draft.openaiCompat.apiKey}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    openaiCompat: { ...draft.openaiCompat, apiKey: e.target.value },
                  })
                }
                placeholder="optional for local servers"
                className={`${inputClass} font-mono`}
              />
            </div>
          </div>
          <TierModelInputs
            models={draft.openaiCompat.models}
            onChange={(models) =>
              setDraft({ ...draft, openaiCompat: { ...draft.openaiCompat, models } })
            }
          />
        </ProviderCard>
      </div>

      <div className="mt-6 flex items-center justify-end gap-3">
        {save.isError && (
          <span className="text-xs text-danger">
            {save.error instanceof Error ? save.error.message : "save failed"}
          </span>
        )}
        {save.isSuccess && !dirty && <span className="text-xs text-ok">saved</span>}
        <button
          type="button"
          disabled={!dirty || save.isPending}
          onClick={() => save.mutate(draft)}
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 transition-opacity disabled:opacity-40"
        >
          Save settings
        </button>
      </div>
    </div>
  );
}

function ProviderCard({
  kind,
  title,
  badge,
  subtitle,
  active,
  onActivate,
  onTest,
  test,
  children,
}: {
  kind: LlmProviderKind;
  title: string;
  badge?: string;
  subtitle: string;
  active: boolean;
  onActivate: () => void;
  onTest: () => void;
  test?: TestState | undefined;
  children: React.ReactNode;
}) {
  const [elapsedS, setElapsedS] = useState(0);
  useEffect(() => {
    if (!test?.running || test.startedAt === undefined) {
      setElapsedS(0);
      return;
    }
    const startedAt = test.startedAt;
    setElapsedS(Math.floor((Date.now() - startedAt) / 1000));
    const id = setInterval(() => {
      setElapsedS(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(id);
  }, [test?.running, test?.startedAt]);

  return (
    <section
      className={`rounded-lg border p-5 transition-colors ${
        active ? "border-accent-dim bg-surface-1" : "border-line bg-surface-1/50"
      }`}
    >
      <div className="mb-4 flex items-start justify-between gap-4">
        <label className="flex cursor-pointer items-start gap-3">
          <input
            type="radio"
            name="active-provider"
            checked={active}
            onChange={onActivate}
            className="mt-1 accent-accent"
          />
          <span>
            <span className="block text-sm font-semibold">
              {title}
              {badge && (
                <span className="ml-2 rounded border border-accent-dim px-1.5 py-0.5 align-middle text-[10px] font-medium uppercase tracking-wide text-accent">
                  {badge}
                </span>
              )}
            </span>
            <span className="block text-xs text-ink-faint">{subtitle}</span>
          </span>
        </label>
        <button
          type="button"
          onClick={onTest}
          disabled={test?.running}
          className="shrink-0 rounded-md border border-line px-3 py-1.5 text-xs text-ink-dim hover:border-accent-dim hover:text-ink disabled:opacity-50"
        >
          {test?.running ? <>testing… <span className="num">{elapsedS}s</span></> : "Test"}
        </button>
      </div>

      {children}

      {test && !test.running && <TestResult kind={kind} test={test} />}
    </section>
  );
}

function TestResult({ kind, test }: { kind: LlmProviderKind; test: TestState }) {
  return (
    <div className="mt-3 rounded-md border border-line bg-surface-2 p-3 text-xs">
      {test.error && <p className="text-danger">{test.error}</p>}
      {test.health && (
        <p className={test.health.ok ? "text-ok" : "text-danger"}>
          {test.health.ok ? "✓" : "✗"} {test.health.detail}
          {test.health.latencyMs !== undefined && (
            <span className="num text-ink-faint"> · {test.health.latencyMs} ms</span>
          )}
        </p>
      )}
      {test.extract && (
        <p className={`mt-1 ${test.extract.ok ? "text-ok" : "text-danger"}`}>
          {test.extract.ok ? (
            <>
              ✓ structured extraction OK{" "}
              <span className="num text-ink-dim">
                ({test.extract.model}
                {test.extract.retried ? ", after retry" : ""}) →{" "}
                {JSON.stringify(test.extract.data)}
              </span>
            </>
          ) : (
            <>✗ extraction failed: {test.extract.error}</>
          )}
        </p>
      )}
      {kind === "claude-code" && test.health && !test.health.ok && (
        <p className="mt-2 text-ink-faint">
          Install Claude Code and run <code className="font-mono">claude login</code>, then test
          again.
        </p>
      )}
    </div>
  );
}

function TierModelInputs({
  models,
  onChange,
}: {
  models: Record<ModelTier, string>;
  onChange: (models: Record<ModelTier, string>) => void;
}) {
  return (
    <div className="grid grid-cols-3 gap-3">
      {TIERS.map((tier) => (
        <div key={tier}>
          <label className={labelClass}>
            {tier} <span className="font-normal text-ink-faint">— {TIER_HINTS[tier]}</span>
          </label>
          <input
            value={models[tier]}
            onChange={(e) => onChange({ ...models, [tier]: e.target.value })}
            className={`${inputClass} font-mono text-xs`}
          />
        </div>
      ))}
    </div>
  );
}

function OllamaTierModelInputs({
  models,
  onChange,
  installed,
}: {
  models: Record<ModelTier, string>;
  onChange: (models: Record<ModelTier, string>) => void;
  installed?: OllamaModelInfo[] | undefined;
}) {
  const datalistId = "ollama-installed-models";

  return (
    <div className="grid grid-cols-3 gap-3">
      {TIERS.map((tier) => {
        const value = models[tier];
        const match = installed?.find((m) => m.name === value);
        const showNotInstalledHint = installed !== undefined && value !== "" && !match;
        const showNoVisionWarning =
          tier === "extraction" && installed !== undefined && match !== undefined &&
          !match.capabilities.includes("vision");

        return (
          <div key={tier}>
            <label className={labelClass}>
              {tier} <span className="font-normal text-ink-faint">— {TIER_HINTS[tier]}</span>
            </label>
            <input
              value={value}
              onChange={(e) => onChange({ ...models, [tier]: e.target.value })}
              className={`${inputClass} font-mono text-xs`}
              {...(installed !== undefined ? { list: datalistId } : {})}
            />
            {showNoVisionWarning && (
              <p className="mt-1 text-xs text-warn">
                {value} can't read datasheet pages (no vision support). Try{" "}
                <code className="font-mono">ollama pull qwen2.5vl:7b</code>.
              </p>
            )}
            {showNotInstalledHint && (
              <p className="mt-1 text-xs text-ink-faint">
                Not installed — run <code className="font-mono">ollama pull {value}</code>.
              </p>
            )}
          </div>
        );
      })}
      {installed !== undefined && (
        <datalist id={datalistId}>
          {installed.map((m) => (
            <option key={m.name} value={m.name} />
          ))}
        </datalist>
      )}
    </div>
  );
}
