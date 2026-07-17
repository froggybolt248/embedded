import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import type { ExtractionFields } from "@embedded/ingest";
import { PinFunction } from "@embedded/core";
import { api } from "../../lib/api";
import type { GroundingStatus } from "@embedded/ingest";
import { ConfidenceChip, GroundingChip, PageChip, StatusBadge } from "./badges";

type RatedParamRow = ExtractionFields["absoluteMax"][number];
type VariantRow = ExtractionFields["variants"][number];
type PowerStateRow = ExtractionFields["powerStates"][number];
type PinRow = ExtractionFields["pins"][number];
type InterfaceRow = ExtractionFields["interfaces"][number];
type DecouplingRow = ExtractionFields["decoupling"][number];

type ArraySection =
  | "variants"
  | "absoluteMax"
  | "recommendedOperating"
  | "powerStates"
  | "pins"
  | "interfaces"
  | "decoupling";
type SectionKey = "identity" | ArraySection;

interface Included {
  identity: boolean;
  variants: boolean[];
  absoluteMax: boolean[];
  recommendedOperating: boolean[];
  powerStates: boolean[];
  pins: boolean[];
  interfaces: boolean[];
  decoupling: boolean[];
}

interface FlatRow {
  key: string;
  section: SectionKey;
  index: number;
  page: number;
  snippet: string | undefined;
}

const INTERFACE_KINDS = ["i2c", "spi", "uart", "gpio", "analog", "pwm", "usb", "rf", "power"] as const;

const smallInputClass =
  "min-w-0 rounded border border-line bg-surface-1 px-2 py-1.5 text-xs outline-none placeholder:text-ink-faint focus:border-accent-dim";
const fieldLabelClass = "mb-0.5 block text-[10px] text-ink-faint";

/**
 * A row whose citation failed the grounding check starts unticked. It stays
 * visible and editable — the reviewer may know the value is right and fix the
 * snippet — but it must be opted in deliberately, never swept into the library
 * by an absent-minded Commit. Everything else starts ticked as before.
 */
const startsIncluded = (row: { grounding?: GroundingStatus | undefined }): boolean =>
  row.grounding === undefined || row.grounding === "verified";

function buildIncluded(fields: ExtractionFields): Included {
  return {
    identity: fields.identity !== null,
    variants: fields.variants.map(startsIncluded),
    absoluteMax: fields.absoluteMax.map(startsIncluded),
    recommendedOperating: fields.recommendedOperating.map(startsIncluded),
    powerStates: fields.powerStates.map(startsIncluded),
    pins: fields.pins.map(() => true),
    interfaces: fields.interfaces.map(startsIncluded),
    decoupling: fields.decoupling.map(startsIncluded),
  };
}

function buildFlatRows(fields: ExtractionFields): FlatRow[] {
  const rows: FlatRow[] = [];
  if (fields.identity) {
    rows.push({
      key: "identity",
      section: "identity",
      index: -1,
      page: fields.identity.page,
      snippet: fields.identity.snippet,
    });
  }
  const pushArray = <T extends { page: number; snippet?: string }>(
    section: ArraySection,
    arr: T[],
  ) => {
    arr.forEach((r, i) =>
      rows.push({ key: `${section}:${i}`, section, index: i, page: r.page, snippet: r.snippet }),
    );
  };
  pushArray("variants", fields.variants);
  pushArray("absoluteMax", fields.absoluteMax);
  pushArray("recommendedOperating", fields.recommendedOperating);
  pushArray("powerStates", fields.powerStates);
  pushArray("pins", fields.pins);
  pushArray("interfaces", fields.interfaces);
  pushArray("decoupling", fields.decoupling);
  return rows;
}

function buildCommitPayload(fields: ExtractionFields, included: Included): ExtractionFields {
  return {
    identity: included.identity ? fields.identity : null,
    variants: fields.variants.filter((_, i) => included.variants[i]),
    absoluteMax: fields.absoluteMax.filter((_, i) => included.absoluteMax[i]),
    recommendedOperating: fields.recommendedOperating.filter(
      (_, i) => included.recommendedOperating[i],
    ),
    powerStates: fields.powerStates.filter((_, i) => included.powerStates[i]),
    pins: fields.pins.filter((_, i) => included.pins[i]),
    interfaces: fields.interfaces.filter((_, i) => included.interfaces[i]),
    decoupling: fields.decoupling.filter((_, i) => included.decoupling[i]),
  };
}

function includedCount(included: Included): number {
  return (
    (included.identity ? 1 : 0) +
    included.variants.filter(Boolean).length +
    included.absoluteMax.filter(Boolean).length +
    included.recommendedOperating.filter(Boolean).length +
    included.powerStates.filter(Boolean).length +
    included.pins.filter(Boolean).length +
    included.interfaces.filter(Boolean).length +
    included.decoupling.filter(Boolean).length
  );
}

function attrsToText(attrs: Record<string, string | number>): string {
  return Object.entries(attrs)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");
}

function textToAttrs(text: string): Record<string, string | number> {
  const result: Record<string, string | number> = {};
  text
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .forEach((pair) => {
      const eq = pair.indexOf("=");
      if (eq === -1) return;
      const key = pair.slice(0, eq).trim();
      const raw = pair.slice(eq + 1).trim();
      if (!key) return;
      const n = Number(raw);
      result[key] = raw !== "" && Number.isFinite(n) ? n : raw;
    });
  return result;
}

function Field({ label, width, children }: { label: string; width?: string; children: ReactNode }) {
  return (
    <div className={width ?? "min-w-24 flex-1"}>
      <label className={fieldLabelClass}>{label}</label>
      {children}
    </div>
  );
}

function TextField({
  value,
  onCommit,
  placeholder,
  mono,
  className,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  mono?: boolean;
  className?: string;
}) {
  return (
    <input
      type="text"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onCommit(e.target.value)}
      className={`${smallInputClass} ${mono ? "font-mono" : ""} ${className ?? ""}`}
    />
  );
}

/**
 * Pin functions are a closed vocabulary, so this edits a draft string and only
 * commits on blur — filtering per keystroke would delete characters mid-word.
 * Unknown tokens are surfaced rather than silently dropped: a reviewer who
 * typed "sda" should see why it didn't stick.
 */
function PinFunctionsField({
  value,
  onCommit,
}: {
  value: PinFunction[];
  onCommit: (v: PinFunction[]) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const text = draft ?? value.join(", ");
  const tokens = text
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const invalid = tokens.filter((t) => !PinFunction.safeParse(t).success);

  return (
    <div>
      <input
        type="text"
        value={text}
        list="pin-functions"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          onCommit(tokens.filter((t): t is PinFunction => PinFunction.safeParse(t).success));
          setDraft(null);
        }}
        className={`${smallInputClass} font-mono`}
      />
      {invalid.length > 0 && (
        <p className="mt-1 text-[11px] text-warn">
          not a pin function: {invalid.join(", ")} — pick from the list
        </p>
      )}
    </div>
  );
}

function NumberField({
  value,
  onCommit,
  placeholder,
  className,
}: {
  value: number | null | undefined;
  onCommit: (v: number | null) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <input
      type="number"
      inputMode="decimal"
      value={value ?? ""}
      placeholder={placeholder}
      onChange={(e) => {
        const raw = e.target.value;
        if (raw === "") {
          onCommit(null);
          return;
        }
        const n = e.target.valueAsNumber;
        if (Number.isFinite(n)) onCommit(n);
      }}
      className={`${smallInputClass} num ${className ?? ""}`}
    />
  );
}

function AttrsField({
  value,
  onCommit,
}: {
  value: Record<string, string | number>;
  onCommit: (v: Record<string, string | number>) => void;
}) {
  const [text, setText] = useState(() => attrsToText(value));
  return (
    <input
      type="text"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={() => onCommit(textToAttrs(text))}
      placeholder="key=value, key=value"
      className={`${smallInputClass} flex-1 font-mono`}
    />
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(true);
  return (
    <section className="rounded-lg border border-line bg-surface-1">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between border-b border-line px-4 py-2.5 text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
          {title} <span className="num text-ink-dim">({count})</span>
        </span>
        <span className="font-mono text-xs text-ink-faint">{open ? "▾" : "▸"}</span>
      </button>
      {open &&
        (count === 0 ? (
          <p className="px-4 py-3 text-sm text-ink-faint">no entries extracted</p>
        ) : (
          <div className="divide-y divide-line">{children}</div>
        ))}
    </section>
  );
}

function EntryRow({
  focused,
  included,
  onFocus,
  onToggleInclude,
  page,
  confidence,
  grounding,
  children,
}: {
  focused: boolean;
  included: boolean;
  onFocus: () => void;
  onToggleInclude: () => void;
  page: number;
  confidence: number | undefined;
  grounding?: GroundingStatus | undefined;
  children: ReactNode;
}) {
  return (
    <div
      onClick={onFocus}
      className={`flex cursor-pointer items-start gap-3 border-l-2 px-4 py-3 transition-colors ${
        focused ? "border-accent bg-surface-2" : "border-transparent hover:bg-surface-2/50"
      }`}
    >
      <input
        type="checkbox"
        checked={included}
        onChange={onToggleInclude}
        className="mt-1 shrink-0 accent-accent"
      />
      <div className={`min-w-0 flex-1 ${included ? "" : "opacity-40"}`}>
        <div className="flex flex-wrap items-end gap-2">{children}</div>
        <div className="mt-1.5 flex items-center gap-1.5">
          <PageChip page={page} />
          <ConfidenceChip confidence={confidence} />
          <GroundingChip grounding={grounding} />
        </div>
      </div>
    </div>
  );
}

export function ExtractionReviewPage() {
  const { runId } = useParams({ from: "/library/runs/$runId" });
  const navigate = useNavigate();
  const qc = useQueryClient();

  const { data: run, isLoading, isError } = useQuery({
    queryKey: ["extraction-run", runId],
    queryFn: () => api.extractionRuns.get(runId),
    refetchInterval: (query) => (query.state.data?.status === "running" ? 2000 : false),
  });

  const [fields, setFields] = useState<ExtractionFields | null>(null);
  const [included, setIncluded] = useState<Included | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const [target, setTarget] = useState<"new" | "existing">("new");
  const [targetComponentId, setTargetComponentId] = useState("");
  const seededFor = useRef<string | null>(null);

  useEffect(() => {
    if (!run || run.status === "running") return;
    if (seededFor.current === run.id) return;
    seededFor.current = run.id;
    const seeded = run.fields as unknown as ExtractionFields;
    setFields(seeded);
    setIncluded(buildIncluded(seeded));
  }, [run]);

  const { data: datasheet } = useQuery({
    queryKey: ["datasheet", run?.datasheetId],
    queryFn: () => api.datasheets.get(run!.datasheetId),
    enabled: !!run,
  });

  const { data: components } = useQuery({
    queryKey: ["components"],
    queryFn: () => api.components.list(),
  });

  const flatRows = useMemo(() => (fields ? buildFlatRows(fields) : []), [fields]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (flatRows.length === 0) return;
      if (e.key === "j" || e.key === "k") {
        e.preventDefault();
        setFocusedKey((prev) => {
          const idx = prev ? flatRows.findIndex((r) => r.key === prev) : -1;
          const nextIdx =
            e.key === "j" ? Math.min(flatRows.length - 1, idx + 1) : Math.max(0, idx - 1);
          return flatRows[nextIdx]?.key ?? prev;
        });
      } else if (e.key === "x" && focusedKey) {
        e.preventDefault();
        const row = flatRows.find((r) => r.key === focusedKey);
        if (row) toggleIncluded(row.section, row.index);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [flatRows, focusedKey]);

  const retry = useMutation({
    mutationFn: async () => {
      if (!run) throw new Error("no run loaded");
      return api.datasheets.extract(run.datasheetId);
    },
    onSuccess: (newRun) => {
      navigate({ to: "/library/runs/$runId", params: { runId: newRun.id } });
    },
  });

  const commit = useMutation({
    mutationFn: (payload: { fields: ExtractionFields; componentId?: string }) =>
      api.extractionRuns.commit(runId, payload),
    onSuccess: ({ component }) => {
      qc.invalidateQueries({ queryKey: ["components"] });
      qc.invalidateQueries({ queryKey: ["extraction-run", runId] });
      if (run) {
        qc.invalidateQueries({ queryKey: ["datasheet-runs", run.datasheetId] });
        qc.invalidateQueries({ queryKey: ["datasheet", run.datasheetId] });
      }
      navigate({ to: "/library/components/$componentId", params: { componentId: component.id } });
    },
  });

  function toggleIncluded(section: SectionKey, index: number) {
    setIncluded((prev) => {
      if (!prev) return prev;
      if (section === "identity") return { ...prev, identity: !prev.identity };
      const arr = [...prev[section]];
      arr[index] = !arr[index];
      return { ...prev, [section]: arr };
    });
  }

  function updateIdentity(patch: Partial<NonNullable<ExtractionFields["identity"]>>) {
    setFields((prev) => (prev && prev.identity ? { ...prev, identity: { ...prev.identity, ...patch } } : prev));
  }

  function updateRatedParam(
    section: "absoluteMax" | "recommendedOperating",
    index: number,
    patch: Partial<RatedParamRow>,
  ) {
    setFields((prev) => {
      if (!prev) return prev;
      const arr = prev[section].map((r, i) => (i === index ? { ...r, ...patch } : r));
      return { ...prev, [section]: arr };
    });
  }

  function updateVariant(index: number, patch: Partial<VariantRow>) {
    setFields((prev) => {
      if (!prev) return prev;
      const arr = prev.variants.map((r, i) => (i === index ? { ...r, ...patch } : r));
      return { ...prev, variants: arr };
    });
  }

  function updatePowerState(index: number, patch: Partial<PowerStateRow>) {
    setFields((prev) => {
      if (!prev) return prev;
      const arr = prev.powerStates.map((r, i) => (i === index ? { ...r, ...patch } : r));
      return { ...prev, powerStates: arr };
    });
  }

  function updatePin(index: number, patch: Partial<PinRow>) {
    setFields((prev) => {
      if (!prev) return prev;
      const arr = prev.pins.map((r, i) => (i === index ? { ...r, ...patch } : r));
      return { ...prev, pins: arr };
    });
  }

  function updateInterface(index: number, patch: Partial<InterfaceRow>) {
    setFields((prev) => {
      if (!prev) return prev;
      const arr = prev.interfaces.map((r, i) => (i === index ? { ...r, ...patch } : r));
      return { ...prev, interfaces: arr };
    });
  }

  function updateDecoupling(index: number, patch: Partial<DecouplingRow>) {
    setFields((prev) => {
      if (!prev) return prev;
      const arr = prev.decoupling.map((r, i) => (i === index ? { ...r, ...patch } : r));
      return { ...prev, decoupling: arr };
    });
  }

  if (isLoading) {
    return <p className="p-8 text-sm text-ink-faint">Loading…</p>;
  }
  if (isError || !run) {
    return (
      <div className="p-8">
        <p className="text-sm text-danger">Extraction run not found.</p>
        <Link to="/library/datasheets" className="text-sm text-accent hover:underline">
          ← Back to datasheets
        </Link>
      </div>
    );
  }

  const headerBar = (
    <div className="mb-4 flex items-center justify-between gap-4">
      <div>
        <div className="flex items-center gap-2">
          <h1 className="text-xl font-semibold">Extraction review</h1>
          <StatusBadge status={run.status} />
        </div>
        <p className="num mt-1 text-xs text-ink-faint">
          {datasheet?.filename ?? run.datasheetId} · {run.model} · {run.promptVersion}
        </p>
      </div>
      <Link
        to="/library/datasheets/$datasheetId"
        params={{ datasheetId: run.datasheetId }}
        className="text-xs text-ink-faint hover:text-accent"
      >
        ← datasheet
      </Link>
    </div>
  );

  if (run.status === "running") {
    return (
      <div className="mx-auto max-w-3xl p-8">
        {headerBar}
        <div className="rounded-lg border border-accent-dim bg-surface-1 p-6 text-center">
          <p className="text-sm text-ink">Extracting…</p>
          <p className="num mt-2 text-xs text-ink-faint">
            {run.progress ? `${run.progress.phase} — ${run.progress.detail}` : "starting…"}
          </p>
        </div>
      </div>
    );
  }

  if (run.status === "failed") {
    return (
      <div className="mx-auto max-w-3xl p-8">
        {headerBar}
        <div className="rounded-lg border border-danger/40 bg-danger/10 p-6">
          <p className="mb-3 break-all text-sm text-danger">{run.error ?? "extraction failed"}</p>
          <button
            onClick={() => retry.mutate()}
            disabled={retry.isPending}
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 transition-opacity disabled:opacity-40"
          >
            {retry.isPending ? "Starting…" : "Retry extraction"}
          </button>
        </div>
      </div>
    );
  }

  if (!fields || !included) {
    return (
      <div className="p-8">
        {headerBar}
        <p className="text-sm text-ink-faint">Loading review…</p>
      </div>
    );
  }

  const focusedRow = flatRows.find((r) => r.key === focusedKey) ?? null;
  const previewPage = focusedRow?.page ?? 1;
  const pageCount = datasheet?.pageCount ?? previewPage;

  const canCreate = included.identity && fields.identity !== null;
  const commitDisabled =
    commit.isPending ||
    (target === "new" && !canCreate) ||
    (target === "existing" && !targetComponentId);

  function handleCommit() {
    if (!fields || !included) return;
    const payload = buildCommitPayload(fields, included);
    commit.mutate({
      fields: payload,
      ...(target === "existing" && targetComponentId ? { componentId: targetComponentId } : {}),
    });
  }

  return (
    <div className="flex flex-col">
      <div className="px-8 pt-8">
        {headerBar}
        {run.status === "reviewed" && (
          <div className="mb-4 rounded-md border border-line bg-surface-1 px-3 py-2 text-xs text-ink-dim">
            This run has already been committed to the library. Edits below can be re-committed.
          </div>
        )}
      </div>

      <div className="flex gap-6 px-8 pb-28">
        <div className="flex min-w-0 flex-1 flex-col gap-4">
          <Section title="Identity" count={fields.identity ? 1 : 0}>
            {fields.identity && (
              <EntryRow
                focused={focusedKey === "identity"}
                included={included.identity}
                onFocus={() => setFocusedKey("identity")}
                onToggleInclude={() => toggleIncluded("identity", -1)}
                page={fields.identity.page}
                confidence={fields.identity.confidence}
              >
                <Field label="MPN" width="w-40">
                  <TextField
                    value={fields.identity.mpn}
                    onCommit={(v) => updateIdentity({ mpn: v })}
                    mono
                  />
                </Field>
                <Field label="Manufacturer">
                  <TextField
                    value={fields.identity.manufacturer ?? ""}
                    onCommit={(v) => updateIdentity({ manufacturer: v })}
                  />
                </Field>
                <Field label="Description">
                  <TextField
                    value={fields.identity.description ?? ""}
                    onCommit={(v) => updateIdentity({ description: v })}
                  />
                </Field>
              </EntryRow>
            )}
          </Section>

          <Section title="Absolute maximum" count={fields.absoluteMax.length}>
            {fields.absoluteMax.map((r, i) => (
              <EntryRow
                key={i}
                focused={focusedKey === `absoluteMax:${i}`}
                included={included.absoluteMax[i] ?? true}
                onFocus={() => setFocusedKey(`absoluteMax:${i}`)}
                onToggleInclude={() => toggleIncluded("absoluteMax", i)}
                page={r.page}
                confidence={r.confidence}
                grounding={r.grounding}
              >
                <Field label="Label">
                  <TextField value={r.label} onCommit={(v) => updateRatedParam("absoluteMax", i, { label: v })} />
                </Field>
                <Field label="Min" width="w-20">
                  <NumberField value={r.min} onCommit={(v) => updateRatedParam("absoluteMax", i, { min: v })} />
                </Field>
                <Field label="Typ" width="w-20">
                  <NumberField value={r.typ} onCommit={(v) => updateRatedParam("absoluteMax", i, { typ: v })} />
                </Field>
                <Field label="Max" width="w-20">
                  <NumberField value={r.max} onCommit={(v) => updateRatedParam("absoluteMax", i, { max: v })} />
                </Field>
                <Field label="Unit" width="w-16">
                  <TextField
                    value={r.unit}
                    onCommit={(v) => updateRatedParam("absoluteMax", i, { unit: v })}
                    mono
                  />
                </Field>
                <Field label="Conditions">
                  <TextField
                    value={r.conditions ?? ""}
                    onCommit={(v) => updateRatedParam("absoluteMax", i, { conditions: v })}
                  />
                </Field>
              </EntryRow>
            ))}
          </Section>

          <Section title="Recommended operating" count={fields.recommendedOperating.length}>
            {fields.recommendedOperating.map((r, i) => (
              <EntryRow
                key={i}
                focused={focusedKey === `recommendedOperating:${i}`}
                included={included.recommendedOperating[i] ?? true}
                onFocus={() => setFocusedKey(`recommendedOperating:${i}`)}
                onToggleInclude={() => toggleIncluded("recommendedOperating", i)}
                page={r.page}
                confidence={r.confidence}
                grounding={r.grounding}
              >
                <Field label="Label">
                  <TextField
                    value={r.label}
                    onCommit={(v) => updateRatedParam("recommendedOperating", i, { label: v })}
                  />
                </Field>
                <Field label="Min" width="w-20">
                  <NumberField
                    value={r.min}
                    onCommit={(v) => updateRatedParam("recommendedOperating", i, { min: v })}
                  />
                </Field>
                <Field label="Typ" width="w-20">
                  <NumberField
                    value={r.typ}
                    onCommit={(v) => updateRatedParam("recommendedOperating", i, { typ: v })}
                  />
                </Field>
                <Field label="Max" width="w-20">
                  <NumberField
                    value={r.max}
                    onCommit={(v) => updateRatedParam("recommendedOperating", i, { max: v })}
                  />
                </Field>
                <Field label="Unit" width="w-16">
                  <TextField
                    value={r.unit}
                    onCommit={(v) => updateRatedParam("recommendedOperating", i, { unit: v })}
                    mono
                  />
                </Field>
                <Field label="Conditions">
                  <TextField
                    value={r.conditions ?? ""}
                    onCommit={(v) => updateRatedParam("recommendedOperating", i, { conditions: v })}
                  />
                </Field>
              </EntryRow>
            ))}
          </Section>

          <Section title="Power states" count={fields.powerStates.length}>
            {fields.powerStates.map((r, i) => (
              <EntryRow
                key={i}
                focused={focusedKey === `powerStates:${i}`}
                included={included.powerStates[i] ?? true}
                onFocus={() => setFocusedKey(`powerStates:${i}`)}
                onToggleInclude={() => toggleIncluded("powerStates", i)}
                page={r.page}
                confidence={r.confidence}
                grounding={r.grounding}
              >
                <Field label="Name">
                  <TextField value={r.name} onCommit={(v) => updatePowerState(i, { name: v })} />
                </Field>
                <Field label="Typ current" width="w-24">
                  <NumberField value={r.currentTyp} onCommit={(v) => updatePowerState(i, { currentTyp: v })} />
                </Field>
                <Field label="Max current" width="w-24">
                  <NumberField value={r.currentMax} onCommit={(v) => updatePowerState(i, { currentMax: v })} />
                </Field>
                <Field label="Unit" width="w-16">
                  <TextField value={r.unit} onCommit={(v) => updatePowerState(i, { unit: v })} mono />
                </Field>
                <Field label="Conditions">
                  <TextField
                    value={r.conditions ?? ""}
                    onCommit={(v) => updatePowerState(i, { conditions: v })}
                  />
                </Field>
              </EntryRow>
            ))}
          </Section>

          <datalist id="pin-functions">
            {PinFunction.options.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
          <Section title="Pins" count={fields.pins.length}>
            {fields.pins.map((r, i) => (
              <EntryRow
                key={i}
                focused={focusedKey === `pins:${i}`}
                included={included.pins[i] ?? true}
                onFocus={() => setFocusedKey(`pins:${i}`)}
                onToggleInclude={() => toggleIncluded("pins", i)}
                page={r.page}
                confidence={undefined}
              >
                <Field label="Name" width="w-24">
                  <TextField value={r.name} onCommit={(v) => updatePin(i, { name: v })} mono />
                </Field>
                <Field label="#" width="w-14">
                  <TextField value={r.number ?? ""} onCommit={(v) => updatePin(i, { number: v })} />
                </Field>
                <Field label="Functions">
                  <PinFunctionsField
                    value={r.functions}
                    onCommit={(functions) => updatePin(i, { functions })}
                  />
                </Field>
                <Field label="Voltage" width="w-20">
                  <TextField value={r.voltage ?? ""} onCommit={(v) => updatePin(i, { voltage: v })} />
                </Field>
              </EntryRow>
            ))}
          </Section>

          <Section title="Interfaces" count={fields.interfaces.length}>
            {fields.interfaces.map((r, i) => (
              <EntryRow
                key={i}
                focused={focusedKey === `interfaces:${i}`}
                included={included.interfaces[i] ?? true}
                onFocus={() => setFocusedKey(`interfaces:${i}`)}
                onToggleInclude={() => toggleIncluded("interfaces", i)}
                page={r.page}
                confidence={r.confidence}
                grounding={r.grounding}
              >
                <Field label="Kind" width="w-24">
                  <select
                    value={r.kind}
                    onChange={(e) =>
                      updateInterface(i, { kind: e.target.value as InterfaceRow["kind"] })
                    }
                    className={`${smallInputClass} font-mono`}
                  >
                    {INTERFACE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {k}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label="Attrs">
                  <AttrsField value={r.attrs} onCommit={(v) => updateInterface(i, { attrs: v })} />
                </Field>
              </EntryRow>
            ))}
          </Section>

          {/* Only rendered when the datasheet actually enumerates orderable parts —
              a single-part datasheet has no ordering table and shows nothing here. */}
          {fields.variants.length > 0 && (
            <Section title="Orderable variants" count={fields.variants.length}>
              {fields.variants.map((r, i) => (
                <EntryRow
                  key={i}
                  focused={focusedKey === `variants:${i}`}
                  included={included.variants[i] ?? true}
                  onFocus={() => setFocusedKey(`variants:${i}`)}
                  onToggleInclude={() => toggleIncluded("variants", i)}
                  page={r.page}
                  confidence={r.confidence}
                  grounding={r.grounding}
                >
                  <Field label="Ordering code" width="w-44">
                    <TextField
                      value={r.orderingCode}
                      onCommit={(v) => updateVariant(i, { orderingCode: v })}
                      mono
                    />
                  </Field>
                  <Field label="Distinguishing attrs">
                    <AttrsField
                      value={r.attrs}
                      onCommit={(v) =>
                        updateVariant(i, {
                          attrs: Object.fromEntries(
                            Object.entries(v).map(([k, val]) => [k, String(val)]),
                          ),
                        })
                      }
                    />
                  </Field>
                </EntryRow>
              ))}
            </Section>
          )}

          <Section title="Decoupling" count={fields.decoupling.length}>
            {fields.decoupling.map((r, i) => (
              <EntryRow
                key={i}
                focused={focusedKey === `decoupling:${i}`}
                included={included.decoupling[i] ?? true}
                onFocus={() => setFocusedKey(`decoupling:${i}`)}
                onToggleInclude={() => toggleIncluded("decoupling", i)}
                page={r.page}
                confidence={r.confidence}
                grounding={r.grounding}
              >
                <Field label="Description">
                  <TextField
                    value={r.description}
                    onCommit={(v) => updateDecoupling(i, { description: v })}
                  />
                </Field>
                <Field label="Value" width="w-20">
                  <NumberField value={r.value} onCommit={(v) => updateDecoupling(i, { value: v })} />
                </Field>
                <Field label="Unit" width="w-16">
                  <TextField
                    value={r.unit ?? ""}
                    onCommit={(v) => updateDecoupling(i, { unit: v })}
                    mono
                  />
                </Field>
              </EntryRow>
            ))}
          </Section>

          <p className="num text-[11px] text-ink-faint">j / k move focus · x toggle include</p>
        </div>

        <div className="sticky top-6 h-fit w-[26rem] shrink-0 self-start">
          <div className="rounded-lg border border-line bg-surface-1 p-4">
            {focusedRow ? (
              <>
                {focusedRow.snippet ? (
                  <blockquote className="mb-3 rounded border border-line bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-ink-dim">
                    “{focusedRow.snippet}”
                  </blockquote>
                ) : (
                  <p className="mb-3 text-xs text-ink-faint">no snippet captured for this field</p>
                )}
              </>
            ) : (
              <p className="mb-3 text-xs text-ink-faint">Select a field on the left to see its source.</p>
            )}
            <img
              src={api.datasheets.pageUrl(run.datasheetId, previewPage)}
              alt={`Page ${previewPage}`}
              className="w-full rounded border border-line bg-surface-0 object-contain"
            />
            <p className="num mt-2 text-center text-xs text-ink-faint">
              page {previewPage} of {pageCount}
            </p>
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 border-t border-line bg-surface-1 px-8 py-3">
        {commit.isError && (
          <div className="mb-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-xs text-danger">
            {commit.error instanceof Error ? commit.error.message : String(commit.error)}
          </div>
        )}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <span className="num text-xs text-ink-faint">{includedCount(included)} entries included</span>
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-1.5 text-xs text-ink-dim">
              <input
                type="radio"
                checked={target === "new"}
                onChange={() => setTarget("new")}
                className="accent-accent"
              />
              Create new component
            </label>
            <label className="flex items-center gap-1.5 text-xs text-ink-dim">
              <input
                type="radio"
                checked={target === "existing"}
                onChange={() => setTarget("existing")}
                className="accent-accent"
              />
              Update existing
            </label>
            {target === "existing" && (
              <select
                value={targetComponentId}
                onChange={(e) => setTargetComponentId(e.target.value)}
                className={`${smallInputClass} w-48`}
              >
                <option value="">select a component…</option>
                {components?.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.mpn}
                  </option>
                ))}
              </select>
            )}
            <button
              onClick={handleCommit}
              disabled={commitDisabled}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 transition-opacity disabled:opacity-40"
            >
              {commit.isPending ? "Committing…" : "Commit to library"}
            </button>
          </div>
        </div>
        {target === "new" && !canCreate && (
          <p className="mt-1.5 text-right text-[11px] text-warn">
            An identity (mpn) is required to create a component — pick “Update existing” instead.
          </p>
        )}
      </div>
    </div>
  );
}
