import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { InterfaceKind, type Connection } from "@embedded/core";
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

  const error = add.error ?? remove.error ?? null;

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
          No connections yet — wire the MCU to a sensor and the electrical checks have something
          to check.
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

function ConnectionRow({
  connection,
  fromName,
  toName,
  onRemove,
  removing,
}: {
  connection: Connection;
  fromName: string;
  toName: string;
  onRemove: () => void;
  removing: boolean;
}) {
  return (
    <li className="group flex items-center justify-between gap-3 border-b border-line/60 px-4 py-2.5 last:border-b-0">
      <span className="truncate text-xs text-ink">
        {fromName} <span className="text-ink-faint">—{connection.interface}→</span> {toName}
      </span>
      <button
        onClick={onRemove}
        disabled={removing}
        className="invisible shrink-0 rounded px-1.5 py-0.5 text-[11px] text-ink-faint hover:text-danger group-hover:visible disabled:opacity-40"
      >
        remove
      </button>
    </li>
  );
}
