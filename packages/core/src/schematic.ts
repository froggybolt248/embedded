import type { Pin } from "./component.js";
import type { BlockRole } from "./design.js";
import type { ValueSource } from "./sourced-value.js";

/**
 * The pin-level schematic model.
 *
 * This is deliberately NOT a KiCad symbol: it does not need real symbol
 * geometry, because a real schematic groups a part's pins by FUNCTION, not by
 * physical package position — supplies on top, ground on bottom, control
 * signals (reset, interrupt, address-select, analog) on the left, everything
 * else (the bus signals a reader's eye follows left-to-right through the
 * design) on the right. `assignPinSides` below encodes exactly that
 * convention, which is why a schematic can be derived from nothing more than
 * a component's already-known `Pin[]` list.
 */

export type PinSide = "left" | "right" | "top" | "bottom";

export interface SchematicPin {
  name: string;
  number?: string;
  functions: string[];
  side: PinSide;
  /** 0-based ordinal within its side — the drawing order top-to-bottom / left-to-right */
  index: number;
  /** the net this pin is wired to, once net formation has run */
  netId?: string;
}

export interface SchematicSymbol {
  blockId: string;
  label: string;
  role: BlockRole;
  mpn?: string;
  pins: SchematicPin[];
  x: number;
  y: number;
}

export interface SchematicNet {
  id: string;
  kind: "power" | "ground" | "signal";
  label: string;
  voltage?: number;
  pins: Array<{ blockId: string; pinName: string }>;
}

export interface SchematicPassive {
  id: string;
  kind: "capacitor" | "resistor";
  designator: string;
  value: string;
  reason: string;
  betweenNetIds: [string, string];
  nearBlockId?: string;
  citation?: ValueSource;
}

export interface SchematicGap {
  kind: string;
  detail: string;
  blockId?: string;
  connectionId?: string;
}

export interface Schematic {
  symbols: SchematicSymbol[];
  nets: SchematicNet[];
  passives: SchematicPassive[];
  gaps: SchematicGap[];
}

/** A supply pin, by function or by the name convention a part uses when it
 *  ships with no extracted `functions` at all (hand-entered legacy rows). */
// `VS` deliberately excludes a following `S` — `VSS` is the near-universal
// ground name and must not be caught by the `VS` supply shorthand.
const SUPPLY_NAME_RE = /^(VDD|VCC|VBAT|AVDD|VIN|VS(?!S))/i;
/** Ground, including the thermal/exposed pad — it is a ground pin electrically
 *  even though nobody calls it "GND" on the package. */
const GROUND_NAME_RE = /^(GND|VSS|AGND|DGND|EP|PAD)/i;

/** Functions that read left-to-right as "control", not "bus data" — the
 *  reader looks for these on the left the same way they look for supply on top. */
const LEFT_FUNCTIONS = new Set(["reset", "interrupt", "i2c-address-select", "analog-in"]);

function sideFor(pin: Pin): PinSide {
  if (pin.functions.includes("supply") || SUPPLY_NAME_RE.test(pin.name)) return "top";
  if (pin.functions.includes("ground") || GROUND_NAME_RE.test(pin.name)) return "bottom";
  if (pin.functions.some((f) => LEFT_FUNCTIONS.has(f))) return "left";
  // i2c-*, spi-*, uart-*, gpio, nc, and anything unrecognised: the bus/data
  // side, which is where most of a part's pins live.
  return "right";
}

const SIDE_ORDER: PinSide[] = ["top", "right", "bottom", "left"];

/**
 * Group a component's pins onto the four sides of an IC symbol, in the
 * standard convention (see module doc), and order each side deterministically:
 * numerically by pin number when every pin on that side has a purely numeric
 * number, otherwise alphabetically by name. Pure — no component lookup, no I/O.
 */
export function assignPinSides(pins: Pin[]): SchematicPin[] {
  const bySide = new Map<PinSide, Pin[]>(SIDE_ORDER.map((s) => [s, []]));
  for (const pin of pins) bySide.get(sideFor(pin))!.push(pin);

  const result: SchematicPin[] = [];
  for (const side of SIDE_ORDER) {
    const list = bySide.get(side)!;
    const allNumeric = list.length > 0 && list.every((p) => p.number !== undefined && /^\d+$/.test(p.number));
    const ordered = allNumeric
      ? [...list].sort((a, b) => Number(a.number) - Number(b.number))
      : [...list].sort((a, b) => a.name.localeCompare(b.name));

    ordered.forEach((pin, index) => {
      result.push({
        name: pin.name,
        ...(pin.number !== undefined ? { number: pin.number } : {}),
        functions: pin.functions,
        side,
        index,
      });
    });
  }
  return result;
}
