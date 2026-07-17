import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Connection as FlowConnection,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { InterfaceKind, type BlockRole } from "@embedded/core";
import { api, type GroundingStatus } from "../../lib/api";
import { Button, StatusDot, type Tone } from "../../components/ui";

const INTERFACES = InterfaceKind.options;

/** grounding status → the node's dot, in one place */
const GROUNDING_DOT: Record<GroundingStatus, { tone: Tone; pulse: boolean; label: string }> = {
  unbound: { tone: "neutral", pulse: false, label: "" },
  grounding: { tone: "accent", pulse: true, label: "reading datasheet…" },
  grounded: { tone: "ok", pulse: false, label: "grounded" },
  partial: { tone: "warn", pulse: false, label: "no current table" },
  ungrounded: { tone: "warn", pulse: false, label: "no specs" },
  unavailable: { tone: "muted", pulse: false, label: "no datasheet" },
  failed: { tone: "danger", pulse: false, label: "datasheet failed" },
};

interface BlockNodeData extends Record<string, unknown> {
  name: string;
  role: BlockRole;
  status: GroundingStatus;
  bound: boolean;
}
type BlockNode = Node<BlockNodeData, "block">;

/** A block, drawn as a bench module: role tag, name, live grounding dot. */
function BlockNodeView({ data, selected }: NodeProps<BlockNode>) {
  const g = GROUNDING_DOT[data.status];
  return (
    <div
      className={`min-w-[132px] rounded-md border bg-surface-2 px-3 py-2 shadow-sm transition-colors ${
        selected ? "border-accent" : "border-line"
      }`}
    >
      <Handle type="target" position={Position.Left} />
      <div className="flex items-center gap-2">
        <span className="rounded bg-surface-3 px-1.5 py-0.5 text-[9px] uppercase tracking-wide text-ink-faint">
          {data.role}
        </span>
        {g.label && <StatusDot tone={g.tone} pulse={g.pulse} className="ml-auto" />}
      </div>
      <div className="mt-1.5 truncate text-sm text-ink">{data.name}</div>
      <div className="mt-0.5 text-[10px] text-ink-faint">
        {data.bound ? g.label || "bound" : "no part bound"}
      </div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { block: BlockNodeView };

function CanvasInner({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [nodes, setNodes, onNodesChange] = useNodesState<BlockNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [pending, setPending] = useState<{ source: string; target: string } | null>(null);

  const { data: blocks } = useQuery({
    queryKey: ["blocks", projectId],
    queryFn: () => api.blocks.list(projectId),
  });
  const { data: connections } = useQuery({
    queryKey: ["connections", projectId],
    queryFn: () => api.connections.list(projectId),
  });
  const { data: grounding } = useQuery({
    queryKey: ["grounding", projectId],
    queryFn: () => api.projects.grounding(projectId),
  });

  const statusByBlock = useMemo(
    () => new Map((grounding ?? []).map((g) => [g.blockId, g.status])),
    [grounding],
  );
  const nameByBlock = useMemo(
    () => new Map((blocks ?? []).map((b) => [b.id, b.name])),
    [blocks],
  );

  // Rebuild the graph from server truth whenever it changes. Positions come
  // from each block's persisted x/y, so a drag that was saved comes back in
  // the same place; nothing here fights an in-flight drag because we only
  // rebuild on settled query data.
  useEffect(() => {
    if (!blocks) return;
    setNodes(
      blocks.map((b) => ({
        id: b.id,
        type: "block",
        position: { x: b.x, y: b.y },
        data: {
          name: b.name,
          role: b.role,
          status: statusByBlock.get(b.id) ?? (b.componentId ? "grounding" : "unbound"),
          bound: Boolean(b.componentId),
        },
      })),
    );
  }, [blocks, statusByBlock, setNodes]);

  useEffect(() => {
    if (!connections) return;
    setEdges(
      connections.map((c) => ({
        id: c.id,
        source: c.fromBlockId,
        target: c.toBlockId,
        label: c.interface,
        type: "smoothstep",
      })),
    );
  }, [connections, setEdges]);

  const persistPosition = useMutation({
    mutationFn: ({ id, x, y }: { id: string; x: number; y: number }) =>
      api.blocks.update(id, { x, y }),
  });
  const removeBlock = useMutation({
    mutationFn: (id: string) => api.blocks.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["blocks", projectId] });
      qc.invalidateQueries({ queryKey: ["connections", projectId] });
      qc.invalidateQueries({ queryKey: ["grounding", projectId] });
      qc.invalidateQueries({ queryKey: ["findings", projectId] });
    },
  });
  const removeConnection = useMutation({
    mutationFn: (id: string) => api.connections.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["connections", projectId] });
      qc.invalidateQueries({ queryKey: ["findings", projectId] });
    },
  });
  const createConnection = useMutation({
    mutationFn: (input: { fromBlockId: string; toBlockId: string; interface: InterfaceKind }) =>
      api.connections.create(projectId, input),
    onSuccess: () => {
      setPending(null);
      qc.invalidateQueries({ queryKey: ["connections", projectId] });
      qc.invalidateQueries({ queryKey: ["findings", projectId] });
    },
  });

  return (
    <div className="h-[460px] w-full">
      <ReactFlow<BlockNode>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={(_e, node) =>
          persistPosition.mutate({ id: node.id, x: Math.round(node.position.x), y: Math.round(node.position.y) })
        }
        onNodesDelete={(deleted) => deleted.forEach((n) => removeBlock.mutate(n.id))}
        onEdgesDelete={(deleted) => deleted.forEach((e) => removeConnection.mutate(e.id))}
        onConnect={(c: FlowConnection) => {
          if (c.source && c.target && c.source !== c.target) {
            setPending({ source: c.source, target: c.target });
          }
        }}
        fitView
        fitViewOptions={{ padding: 0.3, maxZoom: 1 }}
        proOptions={{ hideAttribution: true }}
        className="rounded-b-lg"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#22262f" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>

      {/* interface picker for a just-drawn wire — inline, not a modal */}
      {pending && (
        <div className="pointer-events-none absolute inset-x-0 top-3 z-[var(--z-dropdown)] flex justify-center">
          <div className="pointer-events-auto flex flex-wrap items-center gap-1.5 rounded-lg border border-line bg-surface-1 px-3 py-2 shadow-lg shadow-black/50">
            <span className="text-[11px] text-ink-dim">
              {nameByBlock.get(pending.source)} <span className="text-ink-faint">→</span>{" "}
              {nameByBlock.get(pending.target)} as
            </span>
            {INTERFACES.map((k) => (
              <button
                key={k}
                type="button"
                onClick={() =>
                  createConnection.mutate({
                    fromBlockId: pending.source,
                    toBlockId: pending.target,
                    interface: k,
                  })
                }
                className="ring-focus rounded border border-line px-1.5 py-0.5 text-[10px] uppercase text-ink-dim transition-colors hover:border-accent-dim hover:text-ink"
              >
                {k}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setPending(null)}
              className="ring-focus ml-0.5 rounded px-1 text-[11px] text-ink-faint hover:text-ink-dim"
            >
              cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The Architecture canvas: blocks as draggable modules, connections as wires.
 * Drag to reposition (persisted to the block's x/y), drag handle-to-handle to
 * wire two blocks (then pick the interface inline), select + Delete to remove.
 * Binding real parts is the Components phase — a node shows its grounding
 * state here but the part is chosen there.
 */
export function BlockCanvas({ projectId }: { projectId: string }) {
  return (
    <div className="relative">
      <ReactFlowProvider>
        <CanvasInner projectId={projectId} />
      </ReactFlowProvider>
    </div>
  );
}

/** The add-block control, kept out of the canvas so the canvas stays gestural. */
export function AddBlockBar({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [role, setRole] = useState<BlockRole>("sensor");
  const ROLES: BlockRole[] = ["mcu", "sensor", "radio", "power", "actuator", "display", "other"];

  const { data: blocks } = useQuery({
    queryKey: ["blocks", projectId],
    queryFn: () => api.blocks.list(projectId),
  });

  // spawn new blocks in a tidy row below the pack, never on top of the origin
  // (where the archetype's MCU sits) — the designer can drag from there.
  const spawn = () => {
    const n = blocks?.length ?? 0;
    return { x: -240 + (n % 4) * 160, y: 220 + Math.floor(n / 4) * 120 };
  };

  const add = useMutation({
    mutationFn: () => api.blocks.create(projectId, { name: name.trim(), role, ...spawn() }),
    onSuccess: () => {
      setName("");
      qc.invalidateQueries({ queryKey: ["blocks", projectId] });
    },
  });

  return (
    <form
      className="flex gap-2 border-t border-line px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) add.mutate();
      }}
    >
      <select
        value={role}
        onChange={(e) => setRole(e.target.value as BlockRole)}
        className="ring-focus rounded border border-line bg-surface-2 px-2 py-1.5 text-xs text-ink-dim outline-none focus:border-accent-dim"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>
            {r}
          </option>
        ))}
      </select>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Add a block — Environment sensor…"
        className="ring-focus flex-1 rounded border border-line bg-surface-2 px-2.5 py-1.5 text-sm text-ink outline-none placeholder:text-ink-faint focus:border-accent-dim"
      />
      <Button type="submit" variant="primary" disabled={!name.trim() || add.isPending}>
        Add
      </Button>
    </form>
  );
}
