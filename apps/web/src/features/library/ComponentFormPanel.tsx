import { useState, type FormEvent } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ComponentCategory,
  ComponentSpecs,
  Lifecycle,
  manualValue,
  type Component,
  type CreateComponentInput,
  type Pin,
  type PowerState,
} from "@embedded/core";
import { api } from "../../lib/api";
import { CATEGORY_LABELS } from "./badges";

const CURRENT_UNITS = ["µA", "mA", "A"] as const;

interface PowerStateRow {
  name: string;
  value: string;
  unit: string;
  conditions: string;
}

interface PinRow {
  name: string;
  number: string;
  functions: string;
  voltage: string;
}

function powerStateRowsFrom(component?: Component): PowerStateRow[] {
  if (!component || component.specs.powerStates.length === 0) return [];
  return component.specs.powerStates.map((ps) => ({
    name: ps.name,
    value: ps.current.typ !== undefined ? String(ps.current.typ.value) : "",
    unit: ps.current.typ?.unit ?? "mA",
    conditions: ps.conditions ?? ps.current.typ?.conditions ?? "",
  }));
}

function pinRowsFrom(component?: Component): PinRow[] {
  if (!component || component.specs.pins.length === 0) return [];
  return component.specs.pins.map((pin) => ({
    name: pin.name,
    number: pin.number ?? "",
    functions: pin.functions.join(", "),
    voltage: pin.voltage ?? "",
  }));
}

const inputClass =
  "w-full rounded-md border border-line bg-surface-1 px-3 py-2 text-sm outline-none placeholder:text-ink-faint focus:border-accent-dim";
const smallInputClass =
  "min-w-0 rounded border border-line bg-surface-1 px-2 py-1.5 text-xs outline-none placeholder:text-ink-faint focus:border-accent-dim";
const labelClass = "mb-1 block text-xs font-medium text-ink-dim";

export function ComponentFormPanel({
  initial,
  onClose,
}: {
  /** when set, the panel edits this component (PATCH); otherwise creates */
  initial?: Component;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [mpn, setMpn] = useState(initial?.mpn ?? "");
  const [manufacturer, setManufacturer] = useState(initial?.manufacturer ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [category, setCategory] = useState<ComponentCategory>(initial?.category ?? "other");
  const [lifecycle, setLifecycle] = useState<Lifecycle>(initial?.lifecycle ?? "unknown");
  const [powerStates, setPowerStates] = useState<PowerStateRow[]>(powerStateRowsFrom(initial));
  const [pins, setPins] = useState<PinRow[]>(pinRowsFrom(initial));
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async (input: CreateComponentInput) =>
      initial ? api.components.update(initial.id, input) : api.components.create(input),
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["components"] });
      qc.invalidateQueries({ queryKey: ["component", saved.id] });
      onClose();
    },
    onError: (err) => setError(err instanceof Error ? err.message : String(err)),
  });

  function buildSpecsPatch() {
    const builtPowerStates: PowerState[] = powerStates
      .filter((row) => row.name.trim())
      .map((row) => {
        const parsed = Number(row.value);
        const hasValue = row.value.trim() !== "" && Number.isFinite(parsed);
        const conditions = row.conditions.trim() || undefined;
        return {
          name: row.name.trim(),
          current: hasValue ? { typ: manualValue(parsed, row.unit, conditions) } : {},
          ...(conditions ? { conditions } : {}),
        };
      });
    const builtPins: Pin[] = pins
      .filter((row) => row.name.trim())
      .map((row) => ({
        name: row.name.trim(),
        ...(row.number.trim() ? { number: row.number.trim() } : {}),
        functions: row.functions
          .split(",")
          .map((f) => f.trim())
          .filter(Boolean),
        ...(row.voltage.trim() ? { voltage: row.voltage.trim() } : {}),
      }));
    // preserve spec groups this form doesn't edit (absoluteMax, interfaces, …)
    const base = initial?.specs ?? ComponentSpecs.parse({});
    return { ...base, powerStates: builtPowerStates, pins: builtPins };
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!mpn.trim()) return;
    setError(null);
    save.mutate({
      mpn: mpn.trim(),
      manufacturer: manufacturer.trim(),
      description: description.trim(),
      category,
      lifecycle,
      specs: buildSpecsPatch(),
    });
  }

  return (
    <div className="fixed inset-0 z-40 flex justify-end">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <form
        onSubmit={submit}
        className="relative flex h-full w-[30rem] max-w-full flex-col border-l border-line bg-surface-1"
      >
        <div className="flex items-center justify-between border-b border-line px-5 py-4">
          <h2 className="text-sm font-semibold">
            {initial ? `Edit ${initial.mpn}` : "Add component"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded px-2 py-1 font-mono text-xs text-ink-faint hover:text-ink"
          >
            esc
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          <div className="flex flex-col gap-4">
            <div>
              <label className={labelClass}>MPN *</label>
              <input
                autoFocus
                value={mpn}
                onChange={(e) => setMpn(e.target.value)}
                placeholder="e.g. BME280"
                className={`${inputClass} font-mono`}
              />
            </div>
            <div>
              <label className={labelClass}>Manufacturer</label>
              <input
                value={manufacturer}
                onChange={(e) => setManufacturer(e.target.value)}
                placeholder="e.g. Bosch Sensortec"
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>Description</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder="What it is, why it's in your library…"
                className={`${inputClass} resize-y`}
              />
            </div>
            <div className="flex gap-3">
              <div className="flex-1">
                <label className={labelClass}>Category</label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value as ComponentCategory)}
                  className={inputClass}
                >
                  {ComponentCategory.options.map((c) => (
                    <option key={c} value={c}>
                      {CATEGORY_LABELS[c]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex-1">
                <label className={labelClass}>Lifecycle</label>
                <select
                  value={lifecycle}
                  onChange={(e) => setLifecycle(e.target.value as Lifecycle)}
                  className={inputClass}
                >
                  {Lifecycle.options.map((l) => (
                    <option key={l} value={l}>
                      {l}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* power states */}
            <section className="mt-2">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-dim">
                  Power states
                </h3>
                <button
                  type="button"
                  onClick={() =>
                    setPowerStates((rows) => [
                      ...rows,
                      { name: "", value: "", unit: "mA", conditions: "" },
                    ])
                  }
                  className="rounded px-2 py-1 text-xs text-accent hover:bg-surface-2"
                >
                  + add state
                </button>
              </div>
              {powerStates.length === 0 && (
                <p className="text-xs text-ink-faint">
                  No power states. Add sleep / idle / active currents to feed power budgets.
                </p>
              )}
              <div className="flex flex-col gap-2">
                {powerStates.map((row, i) => (
                  <div
                    key={i}
                    className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-2 p-2"
                  >
                    <div className="flex items-center gap-1.5">
                      <input
                        value={row.name}
                        onChange={(e) =>
                          setPowerStates((rows) =>
                            rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)),
                          )
                        }
                        placeholder="state (sleep, active…)"
                        className={`${smallInputClass} flex-1`}
                      />
                      <input
                        value={row.value}
                        onChange={(e) =>
                          setPowerStates((rows) =>
                            rows.map((r, j) => (j === i ? { ...r, value: e.target.value } : r)),
                          )
                        }
                        placeholder="typ"
                        inputMode="decimal"
                        className={`${smallInputClass} num w-20 text-right`}
                      />
                      <select
                        value={row.unit}
                        onChange={(e) =>
                          setPowerStates((rows) =>
                            rows.map((r, j) => (j === i ? { ...r, unit: e.target.value } : r)),
                          )
                        }
                        className={`${smallInputClass} num w-16`}
                      >
                        {CURRENT_UNITS.map((u) => (
                          <option key={u} value={u}>
                            {u}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        onClick={() => setPowerStates((rows) => rows.filter((_, j) => j !== i))}
                        className="rounded px-1.5 py-1 text-xs text-ink-faint hover:text-danger"
                        title="Remove state"
                      >
                        ✕
                      </button>
                    </div>
                    <input
                      value={row.conditions}
                      onChange={(e) =>
                        setPowerStates((rows) =>
                          rows.map((r, j) => (j === i ? { ...r, conditions: e.target.value } : r)),
                        )
                      }
                      placeholder="conditions, e.g. VDD=3.3V, TA=25°C"
                      className={smallInputClass}
                    />
                  </div>
                ))}
              </div>
            </section>

            {/* pins */}
            <section className="mt-2">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-dim">Pins</h3>
                <button
                  type="button"
                  onClick={() =>
                    setPins((rows) => [
                      ...rows,
                      { name: "", number: "", functions: "", voltage: "" },
                    ])
                  }
                  className="rounded px-2 py-1 text-xs text-accent hover:bg-surface-2"
                >
                  + add pin
                </button>
              </div>
              {pins.length === 0 && (
                <p className="text-xs text-ink-faint">No pins captured yet.</p>
              )}
              <div className="flex flex-col gap-2">
                {pins.map((row, i) => (
                  <div
                    key={i}
                    className="flex flex-col gap-1.5 rounded-md border border-line bg-surface-2 p-2"
                  >
                    <div className="flex items-center gap-1.5">
                      <input
                        value={row.name}
                        onChange={(e) =>
                          setPins((rows) =>
                            rows.map((r, j) => (j === i ? { ...r, name: e.target.value } : r)),
                          )
                        }
                        placeholder="name (SDA…)"
                        className={`${smallInputClass} flex-1 font-mono`}
                      />
                      <input
                        value={row.number}
                        onChange={(e) =>
                          setPins((rows) =>
                            rows.map((r, j) => (j === i ? { ...r, number: e.target.value } : r)),
                          )
                        }
                        placeholder="#"
                        className={`${smallInputClass} num w-14`}
                      />
                      <input
                        value={row.voltage}
                        onChange={(e) =>
                          setPins((rows) =>
                            rows.map((r, j) => (j === i ? { ...r, voltage: e.target.value } : r)),
                          )
                        }
                        placeholder="voltage"
                        className={`${smallInputClass} num w-20`}
                      />
                      <button
                        type="button"
                        onClick={() => setPins((rows) => rows.filter((_, j) => j !== i))}
                        className="rounded px-1.5 py-1 text-xs text-ink-faint hover:text-danger"
                        title="Remove pin"
                      >
                        ✕
                      </button>
                    </div>
                    <input
                      value={row.functions}
                      onChange={(e) =>
                        setPins((rows) =>
                          rows.map((r, j) => (j === i ? { ...r, functions: e.target.value } : r)),
                        )
                      }
                      placeholder="functions, comma-separated (i2c-sda, gpio…)"
                      className={smallInputClass}
                    />
                  </div>
                ))}
              </div>
            </section>
          </div>
        </div>

        <div className="border-t border-line px-5 py-4">
          {error && <p className="mb-2 break-all text-xs text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-md border border-line px-4 py-2 text-sm text-ink-dim hover:text-ink"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!mpn.trim() || save.isPending}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface-0 transition-opacity disabled:opacity-40"
            >
              {initial ? "Save changes" : "Add component"}
            </button>
          </div>
        </div>
      </form>
    </div>
  );
}
