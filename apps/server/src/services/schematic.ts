import type {
  Block,
  Component,
  Connection,
  InterfaceKind,
  Schematic,
  SchematicGap,
  SchematicNet,
  SchematicPassive,
  SchematicPin,
  SchematicSymbol,
} from "@embedded/core";
import { assignPinSides } from "@embedded/core";
import { decoupling, i2cModeForSpeed, i2cPullup, type DecouplingResult } from "@embedded/calc";

/**
 * Derive a full pin-level schematic from a project's block/connection design.
 *
 * PURE function, no db/fetch inside — the route assembles the snapshot (see
 * apps/server/src/routes/schematic.ts), the same seam rule-targets.ts and
 * firmware.ts already use. Its governing rule is the one that runs through
 * this whole app: a missing number must stay missing. Every net, passive and
 * pin placement below is either read straight off a component's own `Pin[]`,
 * derived from a value the designer explicitly stated, or produced by one of
 * @embedded/calc's real calculators — never invented to fill a gap. Anywhere
 * the inputs are not there, this emits a `SchematicGap` instead of a guess.
 */

export interface SchematicSnapshot {
  project: { id: string; name: string };
  blocks: Block[];
  connections: Connection[];
  /** bound components by id */
  components: Map<string, Component>;
}

const GND_NET_ID = "GND";

/**
 * Deterministic id for a power net, from its voltage: 3.3 -> "VDD_3V3",
 * 5 -> "VDD_5V0", 1.8 -> "VDD_1V8". Rounded to one decimal place — schematic
 * nets are named after a rail, not a measurement, and a rail is always a
 * round-ish number (3.3V, 5V, 1.8V, 12V), never something like 3.287V.
 */
export function powerNetId(voltage: number): string {
  const rounded = Math.round(voltage * 10) / 10;
  const whole = Math.trunc(rounded);
  const tenths = Math.round((Math.abs(rounded) - Math.abs(whole)) * 10);
  return `VDD_${whole}V${tenths}`;
}

const CAPACITANCE_TABLE: Array<[number, string]> = [
  [1, "F"],
  [1e-3, "mF"],
  [1e-6, "µF"],
  [1e-9, "nF"],
  [1e-12, "pF"],
];

const RESISTANCE_TABLE: Array<[number, string]> = [
  [1e9, "GΩ"],
  [1e6, "MΩ"],
  [1e3, "kΩ"],
  [1, "Ω"],
];

/** 3 significant figures, trailing zeros trimmed — "4.70" reads as "4.7". */
function trimSigFigs(n: number): string {
  return String(Number(n.toPrecision(3)));
}

function formatWithPrefix(value: number, table: Array<[number, string]>): string {
  for (const [factor, unit] of table) {
    if (value >= factor) return `${trimSigFigs(value / factor)} ${unit}`;
  }
  // smaller than every table entry: use the smallest unit anyway rather than
  // print "0" — a whisper of a value is still a value.
  const [factor, unit] = table[table.length - 1]!;
  return `${trimSigFigs(value / factor)} ${unit}`;
}

/** Human-readable component value, e.g. 100e-9 F -> "100 nF", 4700 Ω -> "4.7 kΩ". */
export function formatComponentValue(value: number, kind: "capacitor" | "resistor"): string {
  return formatWithPrefix(value, kind === "capacitor" ? CAPACITANCE_TABLE : RESISTANCE_TABLE);
}

/** The signal names a non-power interface needs nets for, and which pin
 *  `functions` string identifies that signal on each end of the connection.
 *  `fromFn`/`toFn` differ for directional buses (SPI MOSI/MISO, UART TX/RX)
 *  because the same net is the controller's output and the peripheral's
 *  input (or vice versa) — matching both ends against the same function
 *  string would either miss real pins or cross-wire TX into TX. */
interface SignalSpec {
  name: string;
  fromFn: string;
  toFn: string;
}

const SIGNALS_BY_INTERFACE: Partial<Record<InterfaceKind, SignalSpec[]>> = {
  i2c: [
    { name: "SDA", fromFn: "i2c-sda", toFn: "i2c-sda" },
    { name: "SCL", fromFn: "i2c-scl", toFn: "i2c-scl" },
  ],
  spi: [
    { name: "SCK", fromFn: "spi-sck", toFn: "spi-sck" },
    // fromBlock is taken as the controller: its data-out (sdo) drives MOSI
    // into the peripheral's data-in (sdi), and vice versa for MISO.
    { name: "MOSI", fromFn: "spi-sdo", toFn: "spi-sdi" },
    { name: "MISO", fromFn: "spi-sdi", toFn: "spi-sdo" },
    { name: "CS", fromFn: "spi-cs", toFn: "spi-cs" },
  ],
  uart: [
    { name: "TX", fromFn: "uart-tx", toFn: "uart-rx" },
    { name: "RX", fromFn: "uart-rx", toFn: "uart-tx" },
  ],
  gpio: [{ name: "IO", fromFn: "gpio", toFn: "gpio" }],
  analog: [{ name: "AIN", fromFn: "analog-in", toFn: "analog-in" }],
  // no dedicated PinFunction exists for rf yet (see component.ts's
  // PinFunction enum) — the net still forms, honestly, with a gap.
  rf: [{ name: "RF", fromFn: "rf", toFn: "rf" }],
};

/** pwm/usb have no signal breakdown defined yet; still handled so an unknown
 *  interface never throws — one generic net, matched against nothing. */
const FALLBACK_SIGNAL: SignalSpec = { name: "SIGNAL", fromFn: "", toFn: "" };

function findPin(symbol: SchematicSymbol, fn: string): SchematicPin | undefined {
  if (fn === "") return undefined;
  return symbol.pins.find((p) => p.functions.includes(fn));
}

function symbolFor(block: Block, components: Map<string, Component>): SchematicSymbol {
  const component = block.componentId ? components.get(block.componentId) : undefined;
  const pins = component ? assignPinSides(component.specs.pins) : [];
  return {
    blockId: block.id,
    label: block.name,
    role: block.role,
    ...(component?.mpn !== undefined ? { mpn: component.mpn } : {}),
    pins,
    x: block.x,
    y: block.y,
  };
}

/** Attach `pin` to `net`, on both sides — the net's pin list AND the pin's
 *  own `netId`, so either can be walked from a rendered symbol or a net. */
function attach(net: SchematicNet, symbol: SchematicSymbol, pin: SchematicPin): void {
  net.pins.push({ blockId: symbol.blockId, pinName: pin.name });
  pin.netId = net.id;
}

export function buildSchematic(snapshot: SchematicSnapshot): Schematic {
  const { blocks, connections, components } = snapshot;

  const symbols = blocks.map((b) => symbolFor(b, components));
  const symbolByBlockId = new Map(symbols.map((s) => [s.blockId, s]));

  const gaps: SchematicGap[] = [];
  const nets: SchematicNet[] = [];
  const netById = new Map<string, SchematicNet>();

  for (const block of blocks) {
    if (!block.componentId) {
      gaps.push({
        kind: "unbound-block",
        detail: `"${block.name}" has no component bound — its pins are unknown, so this symbol has none`,
        blockId: block.id,
      });
    }
  }

  // GND: one net, every bottom-side pin of every symbol, whether or not the
  // block participates in any power connection — ground is implicit on a
  // schematic in a way a stated rail never is.
  const gndNet: SchematicNet = { id: GND_NET_ID, kind: "ground", label: "GND", pins: [] };
  nets.push(gndNet);
  netById.set(gndNet.id, gndNet);
  for (const symbol of symbols) {
    for (const pin of symbol.pins) {
      if (pin.side === "bottom") attach(gndNet, symbol, pin);
    }
  }

  // The rail actually feeding each block, for the passives pass below — same
  // "highest known voltage wins" rule apps/server/src/services/rule-targets.ts
  // uses, kept here rather than imported because that module derives a rule
  // engine `Scope`, not a net id, and pulling it in for one number would be a
  // heavier coupling than re-deriving three lines of the same logic.
  const blockRail = new Map<string, { netId: string; voltage: number }>();

  // POWER: one net per distinct stated voltage; every power connection into a
  // block attaches that block's top-side (supply) pins to its net.
  for (const conn of connections) {
    if (conn.interface !== "power") continue;
    const toBlock = blocks.find((b) => b.id === conn.toBlockId);
    const symbol = symbolByBlockId.get(conn.toBlockId);
    if (!toBlock || !symbol) continue; // connection names a block this design no longer has

    const voltage = conn.attrs.voltage;
    if (voltage === undefined) {
      gaps.push({
        kind: "unstated-rail",
        detail: `power connection into "${toBlock.name}" has no stated voltage — the net forms with no voltage rather than a guessed one`,
        connectionId: conn.id,
      });
      // Still forms a net — the wiring is real even though the voltage isn't
      // known — but its id cannot be voltage-derived, so it is keyed to the
      // connection instead.
      const net: SchematicNet = {
        id: `POWER_${conn.id}`,
        kind: "power",
        label: `${toBlock.name} rail (voltage unstated)`,
        pins: [],
      };
      nets.push(net);
      for (const pin of symbol.pins) if (pin.side === "top") attach(net, symbol, pin);
      continue;
    }

    const id = powerNetId(voltage);
    let net = netById.get(id);
    if (!net) {
      net = { id, kind: "power", label: id, voltage, pins: [] };
      nets.push(net);
      netById.set(id, net);
    }
    for (const pin of symbol.pins) if (pin.side === "top") attach(net, symbol, pin);

    const existingRail = blockRail.get(toBlock.id);
    if (!existingRail || voltage > existingRail.voltage) {
      blockRail.set(toBlock.id, { netId: id, voltage });
    }
  }

  // SIGNAL: one net per interface signal, per non-power connection.
  for (const conn of connections) {
    if (conn.interface === "power") continue;
    const fromBlock = blocks.find((b) => b.id === conn.fromBlockId);
    const toBlock = blocks.find((b) => b.id === conn.toBlockId);
    const fromSymbol = symbolByBlockId.get(conn.fromBlockId);
    const toSymbol = symbolByBlockId.get(conn.toBlockId);
    if (!fromBlock || !toBlock || !fromSymbol || !toSymbol) continue;

    const signals = SIGNALS_BY_INTERFACE[conn.interface] ?? [FALLBACK_SIGNAL];
    for (const sig of signals) {
      const id = `${conn.id}_${sig.name}`;
      const net: SchematicNet = { id, kind: "signal", label: sig.name, pins: [] };
      nets.push(net);

      const fromPin = findPin(fromSymbol, sig.fromFn);
      const toPin = findPin(toSymbol, sig.toFn);
      if (fromPin) attach(net, fromSymbol, fromPin);
      if (toPin) attach(net, toSymbol, toPin);

      if (!fromPin || !toPin) {
        gaps.push({
          kind: "unmatched-signal",
          detail: `${fromBlock.name} -> ${toBlock.name} (${conn.interface}) ${sig.name}: no pin on ${!fromPin ? fromBlock.name : toBlock.name} declares the matching function`,
          connectionId: conn.id,
        });
      }
    }
  }

  const passives: SchematicPassive[] = [];
  let capacitorCount = 0;
  let resistorCount = 0;

  // DECOUPLING: one ceramic per supply pin plus one bulk cap per rail, for
  // every bound block that has supply pins — via @embedded/calc's decoupling(),
  // never hand-rolled. This codebase's specs.decoupling rows are free-text
  // datasheet recommendations (description + a single SourcedValue), not the
  // structured {perPinCapacitanceF, bulkCapacitanceF} pair the calculator's
  // datasheet path expects, so there is nothing groundable to pass it yet —
  // every call here goes through the convention path, which is why `citation`
  // never gets set in practice today. The datasheet branch is real code
  // (decoupling() honors a caller-supplied recommendation) and is exercised
  // directly in schematic.test.ts via `passivesForDecoupling`.
  for (const block of blocks) {
    const symbol = symbolByBlockId.get(block.id);
    const component = block.componentId ? components.get(block.componentId) : undefined;
    if (!symbol || !component) continue;

    const supplyPins = symbol.pins.filter((p) => p.side === "top");
    if (supplyPins.length === 0) continue;

    const rail = blockRail.get(block.id);
    const result = decoupling({ supplyPinCount: supplyPins.length });
    const { passives: emitted, next } = passivesForDecoupling(
      result,
      supplyPins.length,
      rail?.netId ?? GND_NET_ID,
      block.id,
      block.name,
      capacitorCount,
    );
    passives.push(...emitted);
    capacitorCount = next;
  }

  // I2C PULL-UPS: via @embedded/calc's i2cPullup(), never hand-rolled. Needs
  // both the bus capacitance the designer measured/estimated (nothing can
  // derive it — it depends on a board that may not exist yet) and a rail
  // voltage, tried first as the connection's own stated voltage and only then
  // as the resolved rail feeding either endpoint.
  for (const conn of connections) {
    if (conn.interface !== "i2c") continue;
    const toBlock = blocks.find((b) => b.id === conn.toBlockId);
    if (!toBlock) continue;

    const busCapacitanceF = conn.attrs.busCapacitanceF;
    const railV =
      conn.attrs.voltage ?? blockRail.get(conn.toBlockId)?.voltage ?? blockRail.get(conn.fromBlockId)?.voltage;
    const railNetId =
      conn.attrs.voltage !== undefined
        ? powerNetId(conn.attrs.voltage)
        : (blockRail.get(conn.toBlockId)?.netId ?? blockRail.get(conn.fromBlockId)?.netId);

    if (busCapacitanceF === undefined) {
      gaps.push({
        kind: "needs-bus-capacitance",
        detail: `i2c connection to "${toBlock.name}" has no stated bus capacitance — pull-up sizing needs it and cannot guess it`,
        connectionId: conn.id,
      });
      continue;
    }
    if (railV === undefined || railNetId === undefined) {
      gaps.push({
        kind: "unknown-rail",
        detail: `i2c connection to "${toBlock.name}" has no known rail voltage — pull-up sizing needs it and cannot guess it`,
        connectionId: conn.id,
      });
      continue;
    }

    const mode = i2cModeForSpeed(conn.attrs.busSpeedHz ?? 100_000);
    const result = i2cPullup({ vddV: railV, busCapacitanceF, mode });

    if (result.impossible) {
      gaps.push({
        kind: "impossible-pullup",
        detail: `i2c connection to "${toBlock.name}": no single resistor satisfies both the sink-current floor and the rise-time ceiling at ${railV} V / ${busCapacitanceF} F — shorten the bus, buffer it, or slow the clock`,
        connectionId: conn.id,
      });
      continue;
    }

    for (const sig of ["SDA", "SCL"] as const) {
      resistorCount += 1;
      passives.push({
        id: `pullup-${conn.id}-${sig}`,
        kind: "resistor",
        designator: `R${resistorCount}`,
        value: formatComponentValue(result.recommendedOhms, "resistor"),
        reason: `i2c ${sig} pull-up for the ${toBlock.name} bus (${mode}, ${railV} V, ${busCapacitanceF} F)`,
        betweenNetIds: [`${conn.id}_${sig}`, railNetId],
        // a bus pull-up is drawn on the bus it pulls up — anchor it to the
        // peripheral end so it lands next to the connection it belongs to
        nearBlockId: conn.toBlockId,
      });
    }
  }

  return { symbols, nets, passives, gaps };
}

/**
 * The capacitors one decoupling() result produces for a rail: one ceramic per
 * supply pin plus one bulk cap, designated from `startCount + 1`. Split out
 * from `buildSchematic` so the citation-only-when-datasheet rule — set
 * `citation` when (and only when) `basis.kind === "datasheet"` — is directly
 * testable against both branches of `DecouplingResult`, even though
 * `buildSchematic` today only ever supplies the convention branch (see the
 * comment at its call site).
 */
export function passivesForDecoupling(
  result: DecouplingResult,
  supplyPinCount: number,
  powerNetIdOrGnd: string,
  blockId: string,
  blockLabel: string,
  startCount: number,
): { passives: SchematicPassive[]; next: number } {
  const citation = result.basis.kind === "datasheet" ? result.basis.source : undefined;
  const passives: SchematicPassive[] = [];
  let count = startCount;

  for (let i = 0; i < supplyPinCount; i++) {
    count += 1;
    passives.push({
      id: `decoupling-${blockId}-${i}`,
      kind: "capacitor",
      designator: `C${count}`,
      value: formatComponentValue(result.perPinCapacitanceF, "capacitor"),
      reason: `bypass cap for a ${blockLabel} supply pin`,
      betweenNetIds: [powerNetIdOrGnd, GND_NET_ID],
      // a bypass cap belongs AT the pin it bypasses — carrying the block lets
      // the schematic draw it beside that part rather than floating loose,
      // which is also the placement rule the designer has to honor on the board
      nearBlockId: blockId,
      ...(citation !== undefined ? { citation } : {}),
    });
  }

  count += 1;
  passives.push({
    id: `bulk-${blockId}`,
    kind: "capacitor",
    designator: `C${count}`,
    value: formatComponentValue(result.bulkCapacitanceF, "capacitor"),
    reason: `bulk cap for the ${blockLabel} rail`,
    betweenNetIds: [powerNetIdOrGnd, GND_NET_ID],
    nearBlockId: blockId,
    ...(citation !== undefined ? { citation } : {}),
  });

  return { passives, next: count };
}
