import { describe, expect, it } from "vitest";
import type { Block, Component, Connection } from "@embedded/core";
import type { DecouplingResult } from "@embedded/calc";
import {
  buildSchematic,
  formatComponentValue,
  passivesForDecoupling,
  powerNetId,
  type SchematicSnapshot,
} from "./schematic.js";

function block(overrides: Partial<Block> & { id: string; name: string }): Block {
  return {
    projectId: "p1",
    role: "other",
    componentId: null,
    notes: "",
    x: 0,
    y: 0,
    duties: {},
    measuredMa: {},
    ...overrides,
  };
}

function connection(
  overrides: Partial<Connection> & { id: string; fromBlockId: string; toBlockId: string; interface: Connection["interface"] },
): Connection {
  return { projectId: "p1", fromPort: "", toPort: "", attrs: {}, ...overrides };
}

function component(overrides: Partial<Component> & { id: string; mpn: string }): Component {
  return {
    manufacturer: "",
    description: "",
    category: "other",
    lifecycle: "unknown",
    specs: {
      absoluteMax: [],
      recommendedOperating: [],
      powerStates: [],
      pins: [],
      interfaces: [],
      decoupling: [],
      extra: {},
    },
    familyId: null,
    isFamily: false,
    variantAttrs: {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("powerNetId", () => {
  it.each([
    [3.3, "VDD_3V3"],
    [5, "VDD_5V0"],
    [1.8, "VDD_1V8"],
    [3.3, "VDD_3V3"],
  ])("formats %s volts as %s", (v, expected) => {
    expect(powerNetId(v)).toBe(expected);
  });
});

describe("formatComponentValue", () => {
  it("formats 100 nF", () => {
    expect(formatComponentValue(100e-9, "capacitor")).toBe("100 nF");
  });
  it("formats 4.7 µF", () => {
    expect(formatComponentValue(4.7e-6, "capacitor")).toBe("4.7 µF");
  });
  it("formats 4.7 kΩ", () => {
    expect(formatComponentValue(4700, "resistor")).toBe("4.7 kΩ");
  });
  it("formats sub-pF capacitance using the smallest unit rather than 0", () => {
    expect(formatComponentValue(1e-15, "capacitor")).toBe("0.001 pF");
  });
});

describe("passivesForDecoupling — citation-only-when-datasheet rule", () => {
  it("never sets citation for a convention-basis result", () => {
    const result: DecouplingResult = {
      perPinCapacitanceF: 100e-9,
      totalCeramicCapacitanceF: 200e-9,
      bulkCapacitanceF: 3.16e-6,
      bulkRangeF: { minF: 1e-6, maxF: 10e-6 },
      basis: { kind: "convention", note: "no datasheet-stated recommendation" },
    };
    const { passives } = passivesForDecoupling(result, 2, "VDD_3V3", "b1", "MCU", 0);
    expect(passives).toHaveLength(3); // 2 per-pin + 1 bulk
    for (const p of passives) expect(p.citation).toBeUndefined();
    for (const p of passives) expect("citation" in p).toBe(false);
  });

  it("sets citation to the datasheet source when the basis is datasheet", () => {
    const result: DecouplingResult = {
      perPinCapacitanceF: 47e-9,
      totalCeramicCapacitanceF: 47e-9,
      bulkCapacitanceF: 1e-6,
      bulkRangeF: null,
      basis: {
        kind: "datasheet",
        source: { kind: "datasheet", datasheetId: "ds1", page: 5, snippet: "100 nF near VDD" },
      },
    };
    const { passives } = passivesForDecoupling(result, 1, "VDD_3V3", "b1", "MCU", 0);
    expect(passives).toHaveLength(2); // 1 per-pin + 1 bulk
    for (const p of passives) {
      expect(p.citation).toEqual({ kind: "datasheet", datasheetId: "ds1", page: 5, snippet: "100 nF near VDD" });
    }
  });

  it("continues the designator sequence from startCount", () => {
    const result: DecouplingResult = {
      perPinCapacitanceF: 100e-9,
      totalCeramicCapacitanceF: 100e-9,
      bulkCapacitanceF: 3.16e-6,
      bulkRangeF: { minF: 1e-6, maxF: 10e-6 },
      basis: { kind: "convention", note: "x" },
    };
    const { passives, next } = passivesForDecoupling(result, 1, "GND", "b2", "Sensor", 5);
    expect(passives.map((p) => p.designator)).toEqual(["C6", "C7"]);
    expect(next).toBe(7);
  });
});

const MCU_PINS = [
  { name: "VDD", functions: ["supply"] },
  { name: "GND", functions: ["ground"] },
  { name: "SDA", functions: ["i2c-sda"] },
  { name: "SCL", functions: ["i2c-scl"] },
  { name: "RESET", functions: ["reset"] },
];

const SENSOR_PINS = [
  { name: "VDD", functions: ["supply"] },
  { name: "GND", functions: ["ground"] },
  { name: "SDA", functions: ["i2c-sda"] },
  { name: "SCL", functions: ["i2c-scl"] },
];

describe("buildSchematic", () => {
  it("gives a symbol per block, with empty pins and a gap for an unbound block", () => {
    const b1 = block({ id: "b1", name: "Unbound thing" });
    const snapshot: SchematicSnapshot = {
      project: { id: "p1", name: "Proj" },
      blocks: [b1],
      connections: [],
      components: new Map(),
    };
    const schematic = buildSchematic(snapshot);
    expect(schematic.symbols).toHaveLength(1);
    expect(schematic.symbols[0]!.pins).toEqual([]);
    expect(schematic.gaps).toContainEqual(
      expect.objectContaining({ kind: "unbound-block", blockId: "b1" }),
    );
  });

  it("forms a single GND net collecting every symbol's bottom-side pins", () => {
    const mcuComp = component({ id: "c1", mpn: "MCU1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: MCU_PINS, interfaces: [], decoupling: [], extra: {} } });
    const sensorComp = component({ id: "c2", mpn: "SENSOR1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: SENSOR_PINS, interfaces: [], decoupling: [], extra: {} } });
    const mcu = block({ id: "b1", name: "MCU", componentId: "c1" });
    const sensor = block({ id: "b2", name: "Sensor", componentId: "c2" });
    const snapshot: SchematicSnapshot = {
      project: { id: "p1", name: "Proj" },
      blocks: [mcu, sensor],
      connections: [],
      components: new Map([["c1", mcuComp], ["c2", sensorComp]]),
    };
    const schematic = buildSchematic(snapshot);
    const gnd = schematic.nets.find((n) => n.id === "GND")!;
    expect(gnd.kind).toBe("ground");
    expect(gnd.pins).toEqual(
      expect.arrayContaining([
        { blockId: "b1", pinName: "GND" },
        { blockId: "b2", pinName: "GND" },
      ]),
    );
    expect(gnd.pins).toHaveLength(2);
  });

  it("forms a power net named after the stated voltage and attaches the destination's supply pins", () => {
    const mcuComp = component({ id: "c1", mpn: "MCU1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: MCU_PINS, interfaces: [], decoupling: [], extra: {} } });
    const mcu = block({ id: "b1", name: "MCU", componentId: "c1" });
    const battery = block({ id: "b0", name: "Battery" });
    const conn = connection({ id: "conn1", fromBlockId: "b0", toBlockId: "b1", interface: "power", attrs: { voltage: 3.3 } });
    const snapshot: SchematicSnapshot = {
      project: { id: "p1", name: "Proj" },
      blocks: [battery, mcu],
      connections: [conn],
      components: new Map([["c1", mcuComp]]),
    };
    const schematic = buildSchematic(snapshot);
    const rail = schematic.nets.find((n) => n.id === "VDD_3V3")!;
    expect(rail).toBeDefined();
    expect(rail.kind).toBe("power");
    expect(rail.voltage).toBe(3.3);
    expect(rail.pins).toEqual([{ blockId: "b1", pinName: "VDD" }]);
  });

  it("emits an unstated-rail gap and a voltage-absent net when a power connection has no stated voltage", () => {
    const mcuComp = component({ id: "c1", mpn: "MCU1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: MCU_PINS, interfaces: [], decoupling: [], extra: {} } });
    const mcu = block({ id: "b1", name: "MCU", componentId: "c1" });
    const battery = block({ id: "b0", name: "Battery" });
    const conn = connection({ id: "conn1", fromBlockId: "b0", toBlockId: "b1", interface: "power" });
    const snapshot: SchematicSnapshot = {
      project: { id: "p1", name: "Proj" },
      blocks: [battery, mcu],
      connections: [conn],
      components: new Map([["c1", mcuComp]]),
    };
    const schematic = buildSchematic(snapshot);
    expect(schematic.gaps).toContainEqual(
      expect.objectContaining({ kind: "unstated-rail", connectionId: "conn1" }),
    );
    const net = schematic.nets.find((n) => n.id === "POWER_conn1")!;
    expect(net).toBeDefined();
    expect(net.voltage).toBeUndefined();
    expect("voltage" in net).toBe(false);
  });

  it("forms SDA/SCL signal nets for an i2c connection, matching pins by function", () => {
    const mcuComp = component({ id: "c1", mpn: "MCU1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: MCU_PINS, interfaces: [], decoupling: [], extra: {} } });
    const sensorComp = component({ id: "c2", mpn: "SENSOR1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: SENSOR_PINS, interfaces: [], decoupling: [], extra: {} } });
    const mcu = block({ id: "b1", name: "MCU", componentId: "c1" });
    const sensor = block({ id: "b2", name: "Sensor", componentId: "c2" });
    const conn = connection({ id: "conn1", fromBlockId: "b1", toBlockId: "b2", interface: "i2c" });
    const snapshot: SchematicSnapshot = {
      project: { id: "p1", name: "Proj" },
      blocks: [mcu, sensor],
      connections: [conn],
      components: new Map([["c1", mcuComp], ["c2", sensorComp]]),
    };
    const schematic = buildSchematic(snapshot);
    const sda = schematic.nets.find((n) => n.id === "conn1_SDA")!;
    const scl = schematic.nets.find((n) => n.id === "conn1_SCL")!;
    expect(sda.pins).toEqual(expect.arrayContaining([
      { blockId: "b1", pinName: "SDA" },
      { blockId: "b2", pinName: "SDA" },
    ]));
    expect(scl.pins).toEqual(expect.arrayContaining([
      { blockId: "b1", pinName: "SCL" },
      { blockId: "b2", pinName: "SCL" },
    ]));
    expect(schematic.gaps.filter((g) => g.kind === "unmatched-signal")).toHaveLength(0);
  });

  it("emits an unmatched-signal gap when no pin on an endpoint declares the function", () => {
    const mcuComp = component({ id: "c1", mpn: "MCU1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: MCU_PINS, interfaces: [], decoupling: [], extra: {} } });
    const mcu = block({ id: "b1", name: "MCU", componentId: "c1" });
    const unbound = block({ id: "b2", name: "Unbound" });
    const conn = connection({ id: "conn1", fromBlockId: "b1", toBlockId: "b2", interface: "i2c" });
    const snapshot: SchematicSnapshot = {
      project: { id: "p1", name: "Proj" },
      blocks: [mcu, unbound],
      connections: [conn],
      components: new Map([["c1", mcuComp]]),
    };
    const schematic = buildSchematic(snapshot);
    expect(schematic.gaps).toContainEqual(
      expect.objectContaining({ kind: "unmatched-signal", connectionId: "conn1" }),
    );
  });

  it("emits decoupling capacitors for a bound block's supply pins with deterministic designators", () => {
    const mcuComp = component({ id: "c1", mpn: "MCU1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: MCU_PINS, interfaces: [], decoupling: [], extra: {} } });
    const mcu = block({ id: "b1", name: "MCU", componentId: "c1" });
    const snapshot: SchematicSnapshot = {
      project: { id: "p1", name: "Proj" },
      blocks: [mcu],
      connections: [],
      components: new Map([["c1", mcuComp]]),
    };
    const schematic = buildSchematic(snapshot);
    const caps = schematic.passives.filter((p) => p.kind === "capacitor");
    // MCU_PINS has one supply pin -> 1 per-pin ceramic + 1 bulk = 2 caps
    expect(caps).toHaveLength(2);
    expect(caps.map((c) => c.designator)).toEqual(["C1", "C2"]);
    // no datasheet recommendation available in production today -> never cited
    for (const c of caps) expect("citation" in c).toBe(false);
  });

  it("produces identical designators across repeated calls (determinism)", () => {
    const mcuComp = component({ id: "c1", mpn: "MCU1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: MCU_PINS, interfaces: [], decoupling: [], extra: {} } });
    const sensorComp = component({ id: "c2", mpn: "SENSOR1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: SENSOR_PINS, interfaces: [], decoupling: [], extra: {} } });
    const mcu = block({ id: "b1", name: "MCU", componentId: "c1" });
    const sensor = block({ id: "b2", name: "Sensor", componentId: "c2" });
    const conn = connection({ id: "conn1", fromBlockId: "b1", toBlockId: "b2", interface: "i2c", attrs: { voltage: 3.3, busCapacitanceF: 100e-12, busSpeedHz: 400_000 } });
    const powerConn = connection({ id: "conn0", fromBlockId: "b1", toBlockId: "b2", interface: "power", attrs: { voltage: 3.3 } });
    const snapshot: SchematicSnapshot = {
      project: { id: "p1", name: "Proj" },
      blocks: [mcu, sensor],
      connections: [powerConn, conn],
      components: new Map([["c1", mcuComp], ["c2", sensorComp]]),
    };
    const a = buildSchematic(snapshot);
    const b = buildSchematic(snapshot);
    expect(a.passives.map((p) => p.designator)).toEqual(b.passives.map((p) => p.designator));
    expect(a.passives).toEqual(b.passives);
  });

  it("emits SDA/SCL pull-up resistors when bus capacitance and rail voltage are both known", () => {
    const mcuComp = component({ id: "c1", mpn: "MCU1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: MCU_PINS, interfaces: [], decoupling: [], extra: {} } });
    const sensorComp = component({ id: "c2", mpn: "SENSOR1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: SENSOR_PINS, interfaces: [], decoupling: [], extra: {} } });
    const mcu = block({ id: "b1", name: "MCU", componentId: "c1" });
    const sensor = block({ id: "b2", name: "Sensor", componentId: "c2" });
    const conn = connection({
      id: "conn1",
      fromBlockId: "b1",
      toBlockId: "b2",
      interface: "i2c",
      attrs: { voltage: 3.3, busCapacitanceF: 100e-12, busSpeedHz: 400_000 },
    });
    const snapshot: SchematicSnapshot = {
      project: { id: "p1", name: "Proj" },
      blocks: [mcu, sensor],
      connections: [conn],
      components: new Map([["c1", mcuComp], ["c2", sensorComp]]),
    };
    const schematic = buildSchematic(snapshot);
    const resistors = schematic.passives.filter((p) => p.kind === "resistor");
    expect(resistors).toHaveLength(2);
    expect(resistors.map((r) => r.betweenNetIds[0])).toEqual(["conn1_SDA", "conn1_SCL"]);
    for (const r of resistors) expect(r.betweenNetIds[1]).toBe("VDD_3V3");
    expect(schematic.gaps.filter((g) => g.kind === "needs-bus-capacitance" || g.kind === "unknown-rail")).toHaveLength(0);
  });

  it("emits a needs-bus-capacitance gap (and no resistor) when bus capacitance is absent", () => {
    const mcuComp = component({ id: "c1", mpn: "MCU1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: MCU_PINS, interfaces: [], decoupling: [], extra: {} } });
    const sensorComp = component({ id: "c2", mpn: "SENSOR1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: SENSOR_PINS, interfaces: [], decoupling: [], extra: {} } });
    const mcu = block({ id: "b1", name: "MCU", componentId: "c1" });
    const sensor = block({ id: "b2", name: "Sensor", componentId: "c2" });
    const conn = connection({
      id: "conn1",
      fromBlockId: "b1",
      toBlockId: "b2",
      interface: "i2c",
      attrs: { voltage: 3.3 }, // no busCapacitanceF
    });
    const snapshot: SchematicSnapshot = {
      project: { id: "p1", name: "Proj" },
      blocks: [mcu, sensor],
      connections: [conn],
      components: new Map([["c1", mcuComp], ["c2", sensorComp]]),
    };
    const schematic = buildSchematic(snapshot);
    expect(schematic.passives.filter((p) => p.kind === "resistor")).toHaveLength(0);
    expect(schematic.gaps).toContainEqual(
      expect.objectContaining({ kind: "needs-bus-capacitance", connectionId: "conn1" }),
    );
  });

  it("emits an unknown-rail gap (and no resistor) when no voltage is known anywhere", () => {
    const mcuComp = component({ id: "c1", mpn: "MCU1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: MCU_PINS, interfaces: [], decoupling: [], extra: {} } });
    const sensorComp = component({ id: "c2", mpn: "SENSOR1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: SENSOR_PINS, interfaces: [], decoupling: [], extra: {} } });
    const mcu = block({ id: "b1", name: "MCU", componentId: "c1" });
    const sensor = block({ id: "b2", name: "Sensor", componentId: "c2" });
    const conn = connection({
      id: "conn1",
      fromBlockId: "b1",
      toBlockId: "b2",
      interface: "i2c",
      attrs: { busCapacitanceF: 100e-12 }, // no voltage anywhere
    });
    const snapshot: SchematicSnapshot = {
      project: { id: "p1", name: "Proj" },
      blocks: [mcu, sensor],
      connections: [conn],
      components: new Map([["c1", mcuComp], ["c2", sensorComp]]),
    };
    const schematic = buildSchematic(snapshot);
    expect(schematic.passives.filter((p) => p.kind === "resistor")).toHaveLength(0);
    expect(schematic.gaps).toContainEqual(
      expect.objectContaining({ kind: "unknown-rail", connectionId: "conn1" }),
    );
  });

  it("falls back to the block's resolved power net voltage when the connection itself states none", () => {
    const mcuComp = component({ id: "c1", mpn: "MCU1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: MCU_PINS, interfaces: [], decoupling: [], extra: {} } });
    const sensorComp = component({ id: "c2", mpn: "SENSOR1", specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: SENSOR_PINS, interfaces: [], decoupling: [], extra: {} } });
    const mcu = block({ id: "b1", name: "MCU", componentId: "c1" });
    const sensor = block({ id: "b2", name: "Sensor", componentId: "c2" });
    const powerConn = connection({ id: "powerconn", fromBlockId: "b1", toBlockId: "b2", interface: "power", attrs: { voltage: 3.3 } });
    const i2cConn = connection({
      id: "conn1",
      fromBlockId: "b1",
      toBlockId: "b2",
      interface: "i2c",
      attrs: { busCapacitanceF: 100e-12 }, // no voltage on the i2c connection itself
    });
    const snapshot: SchematicSnapshot = {
      project: { id: "p1", name: "Proj" },
      blocks: [mcu, sensor],
      connections: [powerConn, i2cConn],
      components: new Map([["c1", mcuComp], ["c2", sensorComp]]),
    };
    const schematic = buildSchematic(snapshot);
    const resistors = schematic.passives.filter((p) => p.kind === "resistor");
    expect(resistors).toHaveLength(2);
    for (const r of resistors) expect(r.betweenNetIds[1]).toBe("VDD_3V3");
  });
});
