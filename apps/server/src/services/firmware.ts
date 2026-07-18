import type { Block, Component, Connection } from "@embedded/core";

/**
 * v1 firmware codegen — pins.h and platformio.ini from a BLOCK-PORT design.
 *
 * The domain model has no pin numbers anywhere on its own: a Connection says
 * "MCU is wired to Environment sensor over i2c", never "on GPIO4" — UNLESS
 * the designer has stated one via `attrs.pinAssignments`. Inventing a
 * plausible-looking pin here would be exactly this app's characteristic bug —
 * a confident number nobody actually chose, silently baked into generated
 * code a reader would otherwise trust. So a signal with no stated assignment
 * still gets a `#define NAME` with no value and a comment saying so, and the
 * header ends with an `#error` that will not let the file compile until a
 * human fills in whatever is left. A signal the designer DID assign gets a
 * real `#define NAME <PIN>` and drops out of that error entirely. That is
 * the one honest mechanism used throughout: never guess, but once a human
 * states a pin, use it.
 */

export interface FirmwareInput {
  projectName: string;
  blocks: Block[];
  connections: Connection[];
  /** bound components, keyed by component id — used only for MPN comments */
  components: Map<string, Component>;
}

/** Uppercase C identifier: every non-alnum character becomes one underscore. */
function sanitizeIdent(name: string): string {
  const ident = name.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  // an identifier cannot start with a digit
  return /^[0-9]/.test(ident) ? `_${ident}` : ident || "_";
}

/**
 * One C identifier per block, derived from its name, with deterministic
 * collision handling — "Sensor 1" and "Sensor+1" both sanitize to
 * "SENSOR_1", so the second (and third, ...) occurrence in block order gets
 * a numeric suffix instead of silently shadowing the first.
 */
function uniqueBlockIdents(blocks: Block[]): Map<string, string> {
  const used = new Set<string>();
  const idents = new Map<string, string>();
  for (const block of blocks) {
    const base = sanitizeIdent(block.name);
    let ident = base;
    let suffix = 2;
    while (used.has(ident)) {
      ident = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(ident);
    idents.set(block.id, ident);
  }
  return idents;
}

/** PlatformIO env name / ini-safe slug: lowercase, hyphen-separated. */
function sanitizeProjectSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "project";
}

/** The per-interface signals a connection needs pins for. Power is excluded upstream. */
const INTERFACE_SIGNALS: Record<string, string[]> = {
  i2c: ["SDA", "SCL"],
  spi: ["SCK", "MOSI", "MISO", "CS"],
  uart: ["TX", "RX"],
  gpio: ["PIN"],
  analog: ["AIN"],
  rf: ["SIGNAL"],
  pwm: ["PIN"],
  usb: ["DP", "DM"],
};

export function generatePinmapHeader(input: FirmwareInput): string {
  const { projectName, blocks, connections, components } = input;
  const blocksById = new Map(blocks.map((b) => [b.id, b]));
  const idents = uniqueBlockIdents(blocks);

  const lines: string[] = [
    `/*`,
    ` * ${projectName} — pin map header`,
    ` * Generated from the block/connection design. Signals the designer has`,
    ` * assigned a real pin to (Connection.attrs.pinAssignments) are emitted`,
    ` * with that value; every other signal is a placeholder, and the #error`,
    ` * at the bottom of this file will not let it compile until the rest are`,
    ` * filled in by hand.`,
    ` */`,
    `#pragma once`,
    ``,
  ];

  const unassigned: string[] = [];

  const nonPower = connections.filter((c) => c.interface !== "power");
  for (const conn of nonPower) {
    const fromBlock = blocksById.get(conn.fromBlockId);
    const toBlock = blocksById.get(conn.toBlockId);
    // A connection naming a block this design no longer has cannot be named
    // honestly — skip it rather than guess which block was meant.
    if (!fromBlock || !toBlock) continue;

    const fromIdent = idents.get(fromBlock.id)!;
    const toIdent = idents.get(toBlock.id)!;
    const prefix = `${fromIdent}_${toIdent}`;
    const ifaceUpper = conn.interface.toUpperCase();

    lines.push(`/* ---- ${fromBlock.name} <-> ${toBlock.name} (${conn.interface}) ---- */`);
    const fromMpn = fromBlock.componentId ? components.get(fromBlock.componentId)?.mpn : undefined;
    const toMpn = toBlock.componentId ? components.get(toBlock.componentId)?.mpn : undefined;
    if (fromMpn) lines.push(`/* ${fromBlock.name}: ${fromMpn} */`);
    if (toMpn) lines.push(`/* ${toBlock.name}: ${toMpn} */`);

    const signals = INTERFACE_SIGNALS[conn.interface] ?? [ifaceUpper];
    for (const signal of signals) {
      const name = `${prefix}_${ifaceUpper}_${signal}`;
      // The MCU-side pin is what pins.h needs to compile, so `from` wins when
      // both ends are stated; but honor a `to`-only assignment too rather
      // than silently treating it as unassigned.
      const assigned = conn.attrs.pinAssignments?.[signal];
      const pin = assigned?.from ?? assigned?.to;
      if (pin !== undefined) {
        lines.push(`#define ${name} ${pin}  /* ${fromBlock.name} <-> ${toBlock.name} ${conn.interface} ${signal} */`);
      } else {
        lines.push(`#define ${name}  /* PIN NOT ASSIGNED — ${fromBlock.name} <-> ${toBlock.name} ${conn.interface} ${signal} */`);
        unassigned.push(name);
      }
    }

    // Known bus attrs get emitted as real values with their origin — they
    // are facts the designer stated, not guesses this generator is making.
    if (conn.interface === "i2c" && conn.attrs.busSpeedHz !== undefined) {
      lines.push(`#define ${prefix}_I2C_HZ ${conn.attrs.busSpeedHz}  /* from the design */`);
    }

    lines.push(``);
  }

  if (unassigned.length > 0) {
    lines.push(
      `#error "pins.h: ${unassigned.length} pin(s) not assigned in the design (${unassigned.join(", ")}) — assign real pins above before building"`,
    );
    lines.push(``);
  }

  return lines.join("\n");
}

export function generatePlatformioIni(input: FirmwareInput): string {
  const { projectName, blocks, components } = input;
  const envName = sanitizeProjectSlug(projectName);

  const mcu = blocks.find((b) => b.role === "mcu" && b.componentId);
  const mcuMpn = mcu?.componentId ? components.get(mcu.componentId)?.mpn : undefined;
  const boardNote = mcuMpn
    ? `unknown — MCU is bound to ${mcuMpn}, but a PlatformIO board id cannot be derived from an MPN alone`
    : "unknown — no MCU part is bound in this design";

  const lines: string[] = [
    `; ${projectName} — PlatformIO project file`,
    `; Generated from the block/connection design. board and framework are left`,
    `; commented out because this design does not state them — guessing either`,
    `; would silently decide pin mappings and toolchain behavior nobody chose.`,
    `[env:${envName}]`,
    `; board = ${boardNote}`,
    `; framework = arduino  ; TODO: not stated by the design — uncomment and set once chosen`,
    `monitor_speed = 115200`,
    ``,
  ];

  return lines.join("\n");
}
