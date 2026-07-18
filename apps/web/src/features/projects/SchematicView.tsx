import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  ReactFlow,
  ReactFlowProvider,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import type { SchematicPin, SchematicPassive, SchematicSymbol } from "@embedded/core";
import { api } from "../../lib/api";
import { EmptyState } from "../../components/ui";

/* ---- layout constants --------------------------------------------------- */

const PIN_ROW_H = 16; // px per pin row, left/right sides
const BOX_PAD_TOP_LABEL_ONLY = 20; // room for just the label line before the first pin row
const BOX_PAD_TOP_WITH_MPN = 34; // label line + mpn line both need to clear the first pin row
const BOX_PAD_BOTTOM = 10;
const CHAR_W = 5.2; // rough monospace advance at 9px, used to size box width from pin labels
const STUB = 12; // px, left/right pin stub length
const MIN_BOX_W = 96;
/** horizontal lane each top-pin rail label owns, wide enough for "VDD_3V3" */
const RAIL_LANE_W = 58;
/**
 * Block x/y come from the DIAGRAM layout, where nodes are small cards. A
 * schematic symbol is several times bigger, so reusing those coordinates packs
 * the sheet until nothing is readable — spread them out and give each symbol
 * the room its pinout actually needs.
 */
const SYMBOL_GAP = 120;
/** clear space to the left of a symbol where its passives are drawn */
const PASSIVE_GUTTER = 96;
const PASSIVE_PITCH = 48;

/**
 * Symbol footprint, computed the same way SymbolNodeView draws it. The layout
 * pass needs the size BEFORE React renders anything, so both sides derive it
 * from these helpers rather than measuring the DOM — if they ever disagree,
 * symbols overlap.
 */
function estimatedSymbolWidth(symbol: SchematicSymbol): number {
  const left = symbol.pins.filter((p) => p.side === "left");
  const right = symbol.pins.filter((p) => p.side === "right");
  const topCount = symbol.pins.filter((p) => p.side === "top").length;
  const longest = Math.max(longestLabel(left), longestLabel(right), symbol.label.length * 1.6);
  const boxW = Math.max(MIN_BOX_W, Math.round(longest * CHAR_W) + 56, topCount * RAIL_LANE_W);
  return boxW + STUB * 2;
}

function estimatedSymbolHeight(symbol: SchematicSymbol): number {
  const rows = Math.max(
    symbol.pins.filter((p) => p.side === "left").length,
    symbol.pins.filter((p) => p.side === "right").length,
    1,
  );
  const padTop = symbol.mpn ? BOX_PAD_TOP_WITH_MPN : BOX_PAD_TOP_LABEL_ONLY;
  return padTop + BOX_PAD_BOTTOM + rows * PIN_ROW_H + 40;
}

function longestLabel(pins: SchematicPin[]): number {
  return pins.reduce((max, p) => Math.max(max, p.name.length + (p.number ? p.number.length + 1 : 0)), 0);
}

/* ---- SymbolNode: the IC box, pins grouped by function onto four sides --- */

type SymbolNodeData = { symbol: SchematicSymbol; netLabelByPin: Map<string, { label: string; unresolved: boolean }> };
type SymbolFlowNode = Node<SymbolNodeData, "symbol">;

function SideLabel({ pin, align }: { pin: SchematicPin; align: "left" | "right" }) {
  return (
    <div
      className={`flex items-baseline gap-1 truncate font-mono text-[9px] text-ink-dim ${
        align === "right" ? "flex-row-reverse" : ""
      }`}
    >
      <span>{pin.name}</span>
      {pin.number && <span className="text-[8px] text-ink-faint">{pin.number}</span>}
    </div>
  );
}

/** Standard ground symbol: three stacked bars, decreasing width, centered. */
function GroundGlyph() {
  return (
    <div className="flex flex-col items-center gap-[2px]">
      <div className="h-px w-[10px] bg-ink-dim" />
      <div className="h-px w-[6px] bg-ink-dim" />
      <div className="h-px w-[3px] bg-ink-dim" />
    </div>
  );
}

function SymbolNodeView({ data }: NodeProps<SymbolFlowNode>) {
  const { symbol, netLabelByPin } = data;
  const left = symbol.pins.filter((p) => p.side === "left");
  const right = symbol.pins.filter((p) => p.side === "right");
  const top = symbol.pins.filter((p) => p.side === "top");
  const bottom = symbol.pins.filter((p) => p.side === "bottom");

  const rows = Math.max(left.length, right.length, 1);
  const boxPadTop = symbol.mpn ? BOX_PAD_TOP_WITH_MPN : BOX_PAD_TOP_LABEL_ONLY;
  const boxH = boxPadTop + BOX_PAD_BOTTOM + rows * PIN_ROW_H;
  const longest = Math.max(longestLabel(left), longestLabel(right), symbol.label.length * 1.6);
  // the box must also be wide enough that each top pin's rail label gets its
  // own lane — otherwise two supply pins render "VDD_3V3" hard against each
  // other and read as one run-together string
  const boxW = Math.max(
    MIN_BOX_W,
    Math.round(longest * CHAR_W) + 56,
    top.length * RAIL_LANE_W,
  );

  return (
    <div className="relative" style={{ width: boxW + STUB * 2, height: boxH + 40 }}>
      {/* top (supply) stubs + power rail glyphs — no wire is drawn to a rail,
          that's the point of the convention: it keeps supply fan-out off the canvas */}
      {top.map((pin, i) => {
        const x = STUB + ((i + 1) * boxW) / (top.length + 1);
        const net = netLabelByPin.get(pin.name);
        return (
          <div
            key={pin.name}
            className="absolute flex flex-col items-center"
            style={{ left: x - RAIL_LANE_W / 2, top: 0, width: RAIL_LANE_W }}
          >
            <span
              className={`whitespace-nowrap font-mono text-[8px] ${net && !net.unresolved ? "text-ink-dim" : "text-warn"}`}
            >
              {net ? net.label : pin.name}
            </span>
            <div className="h-[14px] w-px bg-line" />
            <div className="h-px w-[14px] bg-ink-dim" />
            <div className="h-2 w-px bg-line" />
            <Handle
              type="target"
              position={Position.Top}
              id={pin.name}
              style={{ left: x - STUB, top: 20, opacity: 0 }}
            />
          </div>
        );
      })}

      {/* the box itself */}
      <div
        className="absolute rounded-none border border-line bg-surface-2"
        style={{ left: STUB, top: 20, width: boxW, height: boxH }}
      >
        <div className="truncate px-2 pt-1 text-xs font-medium text-ink">{symbol.label}</div>
        {symbol.mpn && (
          <div className="truncate px-2 font-mono text-[9px] text-ink-faint">{symbol.mpn}</div>
        )}

        {left.map((pin, i) => (
          <div
            key={pin.name}
            className="absolute px-1"
            style={{ left: 0, top: boxPadTop + i * PIN_ROW_H, width: boxW / 2 - 2 }}
          >
            <SideLabel pin={pin} align="left" />
          </div>
        ))}
        {right.map((pin, i) => (
          <div
            key={pin.name}
            className="absolute px-1"
            style={{ right: 0, top: boxPadTop + i * PIN_ROW_H, width: boxW / 2 - 2 }}
          >
            <SideLabel pin={pin} align="right" />
          </div>
        ))}
      </div>

      {/* left pin stubs + handles */}
      {left.map((pin, i) => (
        <div key={pin.name}>
          <div
            className="absolute h-px bg-line"
            style={{ left: 0, top: 20 + boxPadTop + i * PIN_ROW_H + 5, width: STUB }}
          />
          {/* Every pin carries BOTH a source and a target handle at the same
              point. A net is a wire, not a direction: an I²C bus lands on the
              bus (right) side of both parts, so a source-only right side would
              leave that wire with nowhere to terminate and it would silently
              not render. */}
          <Handle
            type="target"
            position={Position.Left}
            id={pin.name}
            style={{ left: 0, top: 20 + boxPadTop + i * PIN_ROW_H + 5, opacity: 0 }}
          />
          <Handle
            type="source"
            position={Position.Left}
            id={pin.name}
            style={{ left: 0, top: 20 + boxPadTop + i * PIN_ROW_H + 5, opacity: 0 }}
          />
        </div>
      ))}
      {/* right pin stubs + handles */}
      {right.map((pin, i) => (
        <div key={pin.name}>
          <div
            className="absolute h-px bg-line"
            style={{ left: STUB + boxW, top: 20 + boxPadTop + i * PIN_ROW_H + 5, width: STUB }}
          />
          <Handle
            type="source"
            position={Position.Right}
            id={pin.name}
            style={{ left: STUB * 2 + boxW, top: 20 + boxPadTop + i * PIN_ROW_H + 5, opacity: 0 }}
          />
          <Handle
            type="target"
            position={Position.Right}
            id={pin.name}
            style={{ left: STUB * 2 + boxW, top: 20 + boxPadTop + i * PIN_ROW_H + 5, opacity: 0 }}
          />
        </div>
      ))}

      {/* bottom (ground) stubs + ground symbols — same no-wire convention as supply */}
      {bottom.map((pin, i) => {
        const x = STUB + ((i + 1) * boxW) / (bottom.length + 1);
        return (
          <div
            key={pin.name}
            className="absolute flex flex-col items-center"
            style={{ left: x - 10, top: 20 + boxH, width: 20 }}
          >
            <div className="h-2 w-px bg-line" />
            <GroundGlyph />
            <Handle
              type="target"
              position={Position.Bottom}
              id={pin.name}
              style={{ left: 10, top: 0, opacity: 0 }}
            />
          </div>
        );
      })}
    </div>
  );
}

/* ---- PassiveNode: a small cap or resistor glyph, beside its block ------- */

type PassiveNodeData = { passive: SchematicPassive };
type PassiveFlowNode = Node<PassiveNodeData, "passive">;

function PassiveNodeView({ data }: NodeProps<PassiveFlowNode>) {
  const { passive } = data;
  return (
    <div className="flex w-14 flex-col items-center gap-1" title={passive.reason}>
      {passive.kind === "capacitor" ? (
        <div className="flex items-center gap-[3px]">
          <div className="h-[10px] w-px bg-ink-dim" />
          <div className="h-[10px] w-px bg-ink-dim" />
        </div>
      ) : (
        <div className="h-[6px] w-[14px] border border-ink-dim" />
      )}
      <div className="text-center font-mono text-[8px] leading-tight">
        <div className="text-ink-dim">{passive.designator}</div>
        <div className="text-ink-faint">{passive.value}</div>
      </div>
    </div>
  );
}

const nodeTypes = { symbol: SymbolNodeView, passive: PassiveNodeView };

/* ---- assembly: server schematic -> React Flow graph --------------------- */

function SchematicInner({ projectId }: { projectId: string }) {
  const { data: schematic } = useQuery({
    queryKey: ["schematic", projectId],
    queryFn: () => api.projects.schematic(projectId),
  });

  const { nodes, edges } = useMemo(() => {
    if (!schematic) return { nodes: [] as Node[], edges: [] as Edge[] };

    const netById = new Map(schematic.nets.map((n) => [n.id, n]));

    // Lay the sheet out ourselves rather than reusing the block diagram's x/y.
    // Those coordinates were chosen for small diagram cards on a radial layout;
    // a schematic symbol is many times larger, so inheriting them leaves huge
    // dead gaps that force fitView to zoom out until no pin name is legible.
    // Instead: signal flow order left-to-right (supply, then the MCU, then what
    // hangs off it), packed to each symbol's real width, centred on one line.
    const ROLE_RANK: Record<string, number> = { power: 0, mcu: 1 };
    const ordered = [...schematic.symbols].sort((a, b) => {
      const ra = ROLE_RANK[a.role] ?? 2;
      const rb = ROLE_RANK[b.role] ?? 2;
      return ra !== rb ? ra - rb : a.label.localeCompare(b.label);
    });
    const placed = new Map<string, { x: number; y: number }>();
    let cursorX = 0;
    for (const s of ordered) {
      const w = estimatedSymbolWidth(s);
      const h = estimatedSymbolHeight(s);
      // every symbol needs its own passive gutter on the left, so advance past it
      cursorX += PASSIVE_GUTTER;
      placed.set(s.blockId, { x: cursorX, y: -h / 2 });
      cursorX += w + SYMBOL_GAP;
    }

    const symbolNodes: SymbolFlowNode[] = schematic.symbols.map((symbol) => {
      const netLabelByPin = new Map<string, { label: string; unresolved: boolean }>();
      for (const pin of symbol.pins) {
        if (pin.side !== "top") continue;
        const net = pin.netId ? netById.get(pin.netId) : undefined;
        if (net && net.voltage !== undefined) {
          netLabelByPin.set(pin.name, { label: net.label, unresolved: false });
        } else {
          netLabelByPin.set(pin.name, { label: pin.name, unresolved: true });
        }
      }
      return {
        id: symbol.blockId,
        type: "symbol",
        position: placed.get(symbol.blockId) ?? { x: 0, y: 0 },
        data: { symbol, netLabelByPin },
        draggable: false,
      };
    });

    // passives cluster near their block, staggered vertically so they don't
    // overlap each other. `nearBlockId` is optional (a passive the backend
    // can't attribute to one block, e.g. a shared rail's bulk cap) — those
    // fall back to a row beneath every symbol, spread out left-to-right, so
    // they never land on top of a block that happens to sit at the origin.
    const lowestSymbolY = Math.max(...[...placed.values()].map((p) => p.y), 0);
    const passiveCountByBlock = new Map<string, number>();
    let unplacedIndex = 0;
    const passiveNodes: PassiveFlowNode[] = schematic.passives.map((passive) => {
      const near = passive.nearBlockId ? placed.get(passive.nearBlockId) : undefined;
      if (near) {
        const seen = passiveCountByBlock.get(passive.nearBlockId!) ?? 0;
        passiveCountByBlock.set(passive.nearBlockId!, seen + 1);
        // offset to the LEFT of the symbol's outer stub, not into the box itself —
        // box width grows with pin-label length so a fixed rightward offset would
        // often land inside it; staggered y keeps successive passives from stacking
        return {
          id: `passive-${passive.id}`,
          type: "passive",
          position: { x: near.x - PASSIVE_GUTTER, y: near.y + seen * PASSIVE_PITCH },
          data: { passive },
          draggable: false,
        };
      }
      const i = unplacedIndex++;
      return {
        id: `passive-${passive.id}`,
        type: "passive",
        position: { x: i * 80, y: lowestSymbolY + 220 },
        data: { passive },
        draggable: false,
      };
    });

    // only signal nets with exactly two endpoints draw as wires — power/ground
    // use the rail glyph / ground symbol instead (see SymbolNodeView), which is
    // what keeps a real schematic from becoming an unreadable rat's nest
    const signalEdges: Edge[] = schematic.nets
      .filter((n) => n.kind === "signal" && n.pins.length === 2)
      .map((n) => {
        const [a, b] = n.pins as [{ blockId: string; pinName: string }, { blockId: string; pinName: string }];
        return {
          id: n.id,
          source: a.blockId,
          sourceHandle: a.pinName,
          target: b.blockId,
          targetHandle: b.pinName,
          type: "step",
          label: n.label,
          style: { stroke: "var(--color-line)" },
        };
      });

    return { nodes: [...symbolNodes, ...passiveNodes], edges: signalEdges };
  }, [schematic]);

  if (schematic && schematic.symbols.every((s) => s.pins.length === 0)) {
    return (
      <EmptyState>
        No parts are bound yet — a schematic needs real pins to draw. Bind parts to blocks in
        the Components step, then come back here.
      </EmptyState>
    );
  }

  return (
    <div className="h-[460px] w-full">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        fitView
        // a schematic is only useful if the pin names are legible, so let
        // fitView zoom IN on a small design rather than capping at 1:1
        fitViewOptions={{ padding: 0.15, maxZoom: 1.8, minZoom: 0.4 }}
        proOptions={{ hideAttribution: true }}
        className="rounded-b-lg"
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#22262f" />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>

      {schematic && schematic.gaps.length > 0 && (
        <div className="border-t border-line px-4 py-3">
          <div className="mb-1.5 text-[11px] font-medium text-ink-dim">
            {schematic.gaps.length} to resolve
          </div>
          <ul className="space-y-1">
            {schematic.gaps.map((gap, i) => (
              <li key={i} className="flex items-baseline gap-2">
                <span className="rounded bg-surface-3 px-1 py-0.5 text-[9px] uppercase tracking-wide text-warn">
                  {gap.kind}
                </span>
                <span className="text-[11px] text-ink-dim">{gap.detail}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * The pin-level schematic view: a second way to look at the same design as
 * BlockCanvas, derived (not editable) — real IC symbols with pins grouped by
 * function, power rails and ground symbols instead of wires (see the module
 * doc in @embedded/core/schematic for why), and only signal nets drawn as
 * orthogonal wires.
 */
export function SchematicView({ projectId }: { projectId: string }) {
  return (
    <div className="relative">
      <ReactFlowProvider>
        <SchematicInner projectId={projectId} />
      </ReactFlowProvider>
    </div>
  );
}
