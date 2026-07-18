import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { InterfaceKind, type Connection, type ConnectionAttrs } from "@embedded/core";
import { api } from "../../lib/api";

const INTERFACES: InterfaceKind[] = InterfaceKind.options;

/**
 * The server refuses some wiring with a plain sentence ("a block cannot be
 * connected to itself"). `request()` throws with the whole raw body, so show
 * the sentence rather than the JSON around it — and fall back to the raw text
 * if the shape is not what we expect, because a mangled error is still better
 * than a swallowed one.
 */
function serverMessage(err: Error): string {
  const body = err.message.slice(err.message.indexOf(":") + 1).trim();
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "error" in parsed) {
      const { error } = parsed as { error: unknown };
      if (typeof error === "string") return error;
    }
  } catch {
    // not JSON — the raw text is the best we have
  }
  return err.message;
}

/**
 * How the blocks are wired together — placeholder UI, thin on purpose. It
 * shows and edits connections; it derives nothing electrical. The checks
 * that will eventually read these (missing pull-ups, a voltage mismatch on
 * a bus) have no subject to run against until a connection exists.
 */
export function ConnectionsPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [fromBlockId, setFromBlockId] = useState("");
  const [toBlockId, setToBlockId] = useState("");
  const [iface, setIface] = useState<InterfaceKind>(INTERFACES[0]!);

  const { data: blocks } = useQuery({
    queryKey: ["blocks", projectId],
    queryFn: () => api.blocks.list(projectId),
  });
  const nameByBlockId = new Map((blocks ?? []).map((b) => [b.id, b.name]));

  const { data: connections, isLoading } = useQuery({
    queryKey: ["connections", projectId],
    queryFn: () => api.connections.list(projectId),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["connections", projectId] });
    // the connection-scoped rules (pull-ups, level shift) just gained or lost
    // their subject — stale findings would report on wiring that no longer exists
    qc.invalidateQueries({ queryKey: ["findings", projectId] });
  };

  const add = useMutation({
    mutationFn: () =>
      api.connections.create(projectId, { fromBlockId, toBlockId, interface: iface }),
    onSuccess: () => {
      setFromBlockId("");
      setToBlockId("");
      invalidate();
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => api.connections.remove(id),
    onSuccess: invalidate,
  });
  const updateAttrs = useMutation({
    mutationFn: ({ id, attrs }: { id: string; attrs: ConnectionAttrs }) =>
      api.connections.update(id, { attrs }),
    onSuccess: invalidate,
  });

  const error = add.error ?? remove.error ?? updateAttrs.error ?? null;

  return (
    <section className="rounded-lg border border-line bg-surface-1">
      <h2 className="border-b border-line px-4 py-2.5 text-[11px] font-semibold uppercase tracking-wide text-ink-faint">
        Connections
      </h2>

      {isLoading && (
        <div className="px-4 py-6 text-center text-xs text-ink-faint">Loading connections…</div>
      )}

      {connections && connections.length === 0 && (
        <p className="px-4 py-6 text-center text-xs text-ink-faint">
          No connections yet — add one below, or drag between blocks on the canvas.
        </p>
      )}

      {connections && connections.length > 0 && (
        <ul>
          {connections.map((c) => (
            <ConnectionRow
              key={c.id}
              connection={c}
              fromName={nameByBlockId.get(c.fromBlockId) ?? "…"}
              toName={nameByBlockId.get(c.toBlockId) ?? "…"}
              onRemove={() => remove.mutate(c.id)}
              removing={remove.isPending && remove.variables === c.id}
              onSaveAttrs={(attrs) => updateAttrs.mutate({ id: c.id, attrs })}
              saving={updateAttrs.isPending && updateAttrs.variables?.id === c.id}
            />
          ))}
        </ul>
      )}

      {error && (
        <div className="border-t border-line px-4 py-2 text-[11px] text-danger">
          {serverMessage(error)}
        </div>
      )}

      <form
        className="flex flex-wrap gap-2 border-t border-line px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (fromBlockId && toBlockId) add.mutate();
        }}
      >
        <select
          value={fromBlockId}
          onChange={(e) => setFromBlockId(e.target.value)}
          className="rounded border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink-dim outline-none focus:border-accent-dim"
        >
          <option value="">from…</option>
          {blocks?.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <select
          value={iface}
          onChange={(e) => setIface(e.target.value as InterfaceKind)}
          className="rounded border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink-dim outline-none focus:border-accent-dim"
        >
          {INTERFACES.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <select
          value={toBlockId}
          onChange={(e) => setToBlockId(e.target.value)}
          className="rounded border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink-dim outline-none focus:border-accent-dim"
        >
          <option value="">to…</option>
          {blocks?.map((b) => (
            <option key={b.id} value={b.id}>
              {b.name}
            </option>
          ))}
        </select>
        <button
          type="submit"
          disabled={!fromBlockId || !toBlockId || add.isPending}
          className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 disabled:opacity-40"
        >
          Add
        </button>
      </form>
    </section>
  );
}

const FARADS_PER_PF = 1e-12;

/** "3.3 V · 400 kHz · 4.7 kΩ · 150 pF" — only the attrs that are actually set. */
function attrsSummary(attrs: ConnectionAttrs): string {
  const parts: string[] = [];
  if (attrs.voltage !== undefined) parts.push(`${attrs.voltage} V`);
  if (attrs.busSpeedHz !== undefined) parts.push(`${(attrs.busSpeedHz / 1000).toPrecision(3)} kHz`);
  if (attrs.pullupOhms !== undefined) parts.push(`${(attrs.pullupOhms / 1000).toPrecision(3)} kΩ`);
  if (attrs.busCapacitanceF !== undefined) {
    parts.push(`${(attrs.busCapacitanceF / FARADS_PER_PF).toPrecision(3)} pF`);
  }
  return parts.join(" · ");
}

/** Input text -> attrs value: empty means the attribute is ABSENT, never 0. */
function numOrUndefined(s: string): number | undefined {
  if (s.trim() === "") return undefined;
  const n = Number(s);
  return Number.isFinite(n) ? n : undefined;
}

function AttrsEditor({
  attrs,
  onSave,
  saving,
}: {
  attrs: ConnectionAttrs;
  onSave: (attrs: ConnectionAttrs) => void;
  saving: boolean;
}) {
  const [voltage, setVoltage] = useState(attrs.voltage?.toString() ?? "");
  const [busSpeedHz, setBusSpeedHz] = useState(attrs.busSpeedHz?.toString() ?? "");
  const [pullupOhms, setPullupOhms] = useState(attrs.pullupOhms?.toString() ?? "");
  const [capacitancePf, setCapacitancePf] = useState(
    attrs.busCapacitanceF !== undefined ? (attrs.busCapacitanceF / FARADS_PER_PF).toString() : "",
  );

  const input =
    "num mt-1 w-full rounded border border-line bg-surface-2 px-2 py-1 text-xs outline-none focus:border-accent-dim";
  const label = "block text-[10px] text-ink-faint";

  const save = () => {
    const v = numOrUndefined(voltage);
    const speed = numOrUndefined(busSpeedHz);
    const pullup = numOrUndefined(pullupOhms);
    const capPf = numOrUndefined(capacitancePf);
    onSave({
      ...(v !== undefined ? { voltage: v } : {}),
      ...(speed !== undefined ? { busSpeedHz: speed } : {}),
      ...(pullup !== undefined ? { pullupOhms: pullup } : {}),
      ...(capPf !== undefined ? { busCapacitanceF: capPf * FARADS_PER_PF } : {}),
    });
  };

  return (
    <div className="mt-2 grid grid-cols-2 gap-2.5 border-l border-line pl-2.5">
      <label className={label}>
        Voltage (V)
        <input
          type="number"
          step="any"
          value={voltage}
          onChange={(e) => setVoltage(e.target.value)}
          className={input}
        />
      </label>
      <label className={label}>
        Bus speed (Hz)
        <input
          type="number"
          step="any"
          value={busSpeedHz}
          onChange={(e) => setBusSpeedHz(e.target.value)}
          className={input}
        />
      </label>
      <label className={label}>
        Pull-up (Ω)
        <input
          type="number"
          step="any"
          value={pullupOhms}
          onChange={(e) => setPullupOhms(e.target.value)}
          className={input}
        />
      </label>
      <label className={label}>
        Bus capacitance (pF)
        <input
          type="number"
          step="any"
          value={capacitancePf}
          onChange={(e) => setCapacitancePf(e.target.value)}
          className={input}
        />
        <span className="mt-0.5 block text-[10px] font-normal normal-case text-ink-faint">
          ~10 pF per device + ~1 pF/cm of trace
        </span>
      </label>
      <div className="col-span-2">
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="rounded bg-accent px-3 py-1.5 text-xs font-medium text-surface-0 disabled:opacity-40"
        >
          Save
        </button>
      </div>
    </div>
  );
}

function ConnectionRow({
  connection,
  fromName,
  toName,
  onRemove,
  removing,
  onSaveAttrs,
  saving,
}: {
  connection: Connection;
  fromName: string;
  toName: string;
  onRemove: () => void;
  removing: boolean;
  onSaveAttrs: (attrs: ConnectionAttrs) => void;
  saving: boolean;
}) {
  const [open, setOpen] = useState(false);
  const summary = attrsSummary(connection.attrs);

  return (
    <li className="group border-b border-line/60 px-4 py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-3">
        <button
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-baseline gap-2 text-left"
        >
          <span className="shrink-0 text-ink-faint">{open ? "▾" : "▸"}</span>
          <span className="truncate text-xs text-ink">
            {fromName} <span className="text-ink-faint">—{connection.interface}→</span> {toName}
          </span>
          {!open && summary && (
            <span className="num truncate text-[10px] text-ink-faint">{summary}</span>
          )}
        </button>
        <button
          onClick={onRemove}
          disabled={removing}
          className="invisible shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:text-danger group-hover:visible disabled:opacity-40"
        >
          remove
        </button>
      </div>

      {open && <AttrsEditor attrs={connection.attrs} onSave={onSaveAttrs} saving={saving} />}
    </li>
  );
}
