import { describe, expect, it } from "vitest";
import type { Block, Component, Connection } from "@embedded/core";
import { generatePinmapHeader, generatePlatformioIni, type FirmwareInput } from "./firmware.js";

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

function connection(overrides: Partial<Connection> & { id: string; fromBlockId: string; toBlockId: string; interface: Connection["interface"] }): Connection {
  return {
    projectId: "p1",
    fromPort: "",
    toPort: "",
    attrs: {},
    ...overrides,
  };
}

describe("generatePinmapHeader", () => {
  it("emits SDA/SCL defines naming both blocks for an i2c connection", () => {
    const mcu = block({ id: "b1", name: "MCU" });
    const sensor = block({ id: "b2", name: "Environment sensor" });
    const conn = connection({ id: "c1", fromBlockId: "b1", toBlockId: "b2", interface: "i2c" });
    const input: FirmwareInput = {
      projectName: "Test Project",
      blocks: [mcu, sensor],
      connections: [conn],
      components: new Map(),
    };

    const header = generatePinmapHeader(input);

    expect(header).toContain("MCU");
    expect(header).toContain("Environment sensor");
    expect(header).toMatch(/#define MCU_ENVIRONMENT_SENSOR_I2C_SDA/);
    expect(header).toMatch(/#define MCU_ENVIRONMENT_SENSOR_I2C_SCL/);
  });

  it("never emits a pin number — only the honest placeholder mechanism", () => {
    const mcu = block({ id: "b1", name: "MCU" });
    const sensor = block({ id: "b2", name: "Environment sensor" });
    const conn = connection({ id: "c1", fromBlockId: "b1", toBlockId: "b2", interface: "i2c" });
    const input: FirmwareInput = {
      projectName: "Test Project",
      blocks: [mcu, sensor],
      connections: [conn],
      components: new Map(),
    };

    const header = generatePinmapHeader(input);

    // every signal define has no assigned value — just the placeholder comment
    for (const m of header.matchAll(/#define\s+\S+\s\s\/\*\s(PIN NOT ASSIGNED[^*]*)\*\//g)) {
      expect(m[1]).toMatch(/PIN NOT ASSIGNED/);
    }
    // the define line for a signal must not be immediately followed by a bare number
    expect(header).not.toMatch(/#define\s+\S+_(SDA|SCL|SCK|MOSI|MISO|CS|TX|RX|PIN|AIN)\s+\d+/);
    // and the file refuses to compile until pins are assigned
    expect(header).toMatch(/#error "pins\.h: \d+ pin\(s\) not assigned/);
  });

  it("emits busSpeedHz as a real value with its origin commented, when present", () => {
    const mcu = block({ id: "b1", name: "MCU" });
    const sensor = block({ id: "b2", name: "Sensor" });
    const withSpeed = connection({
      id: "c1",
      fromBlockId: "b1",
      toBlockId: "b2",
      interface: "i2c",
      attrs: { busSpeedHz: 400_000 },
    });
    const withoutSpeed = connection({ id: "c2", fromBlockId: "b1", toBlockId: "b2", interface: "i2c" });

    const withInput: FirmwareInput = {
      projectName: "P",
      blocks: [mcu, sensor],
      connections: [withSpeed],
      components: new Map(),
    };
    const withoutInput: FirmwareInput = {
      projectName: "P",
      blocks: [mcu, sensor],
      connections: [withoutSpeed],
      components: new Map(),
    };

    expect(generatePinmapHeader(withInput)).toMatch(/#define MCU_SENSOR_I2C_HZ 400000 {2}\/\* from the design \*\//);
    expect(generatePinmapHeader(withoutInput)).not.toMatch(/_I2C_HZ/);
  });

  it("sanitizes block names into C identifiers", () => {
    const a = block({ id: "b1", name: "Environment sensor!" });
    const b = block({ id: "b2", name: "MCU" });
    const conn = connection({ id: "c1", fromBlockId: "b1", toBlockId: "b2", interface: "gpio" });
    const input: FirmwareInput = {
      projectName: "P",
      blocks: [a, b],
      connections: [conn],
      components: new Map(),
    };

    expect(generatePinmapHeader(input)).toContain("ENVIRONMENT_SENSOR__MCU_GPIO_PIN");
  });

  it("keeps colliding sanitized names distinct", () => {
    const a = block({ id: "b1", name: "Sensor 1" });
    const b = block({ id: "b2", name: "Sensor+1" });
    const mcu = block({ id: "b3", name: "MCU" });
    const conn1 = connection({ id: "c1", fromBlockId: "b3", toBlockId: "b1", interface: "gpio" });
    const conn2 = connection({ id: "c2", fromBlockId: "b3", toBlockId: "b2", interface: "gpio" });
    const input: FirmwareInput = {
      projectName: "P",
      blocks: [a, b, mcu],
      connections: [conn1, conn2],
      components: new Map(),
    };

    const header = generatePinmapHeader(input);
    expect(header).toContain("MCU_SENSOR_1_GPIO_PIN");
    expect(header).toContain("MCU_SENSOR_1_2_GPIO_PIN");
  });

  it("is deterministic — same input, byte-identical output", () => {
    const mcu = block({ id: "b1", name: "MCU" });
    const sensor = block({ id: "b2", name: "Environment sensor" });
    const conn = connection({
      id: "c1",
      fromBlockId: "b1",
      toBlockId: "b2",
      interface: "i2c",
      attrs: { busSpeedHz: 100_000 },
    });
    const input: FirmwareInput = {
      projectName: "Test Project",
      blocks: [mcu, sensor],
      connections: [conn],
      components: new Map(),
    };

    expect(generatePinmapHeader(input)).toBe(generatePinmapHeader(input));
    expect(generatePlatformioIni(input)).toBe(generatePlatformioIni(input));
  });

  it("keeps the #error and lists every signal when nothing is assigned", () => {
    const mcu = block({ id: "b1", name: "MCU" });
    const sensor = block({ id: "b2", name: "Sensor" });
    const conn = connection({ id: "c1", fromBlockId: "b1", toBlockId: "b2", interface: "i2c" });
    const input: FirmwareInput = { projectName: "P", blocks: [mcu, sensor], connections: [conn], components: new Map() };

    const header = generatePinmapHeader(input);
    expect(header).toMatch(/#error "pins\.h: 2 pin\(s\) not assigned in the design \(MCU_SENSOR_I2C_SDA, MCU_SENSOR_I2C_SCL\)/);
    expect(header).not.toMatch(/#define MCU_SENSOR_I2C_SDA \d/);
    expect(header).not.toMatch(/#define MCU_SENSOR_I2C_SCL \d/);
  });

  it("emits a real value for an assigned signal and leaves the rest unassigned, #error still present", () => {
    const mcu = block({ id: "b1", name: "MCU" });
    const sensor = block({ id: "b2", name: "Sensor" });
    const conn = connection({
      id: "c1",
      fromBlockId: "b1",
      toBlockId: "b2",
      interface: "i2c",
      attrs: { pinAssignments: { SDA: { from: "GPIO4" } } },
    });
    const input: FirmwareInput = { projectName: "P", blocks: [mcu, sensor], connections: [conn], components: new Map() };

    const header = generatePinmapHeader(input);
    expect(header).toMatch(/#define MCU_SENSOR_I2C_SDA GPIO4 {2}\/\*/);
    expect(header).toMatch(/#define MCU_SENSOR_I2C_SCL {2}\/\* PIN NOT ASSIGNED/);
    expect(header).toMatch(/#error "pins\.h: 1 pin\(s\) not assigned in the design \(MCU_SENSOR_I2C_SCL\)/);
  });

  it("drops the #error entirely once every signal is assigned", () => {
    const mcu = block({ id: "b1", name: "MCU" });
    const sensor = block({ id: "b2", name: "Sensor" });
    const conn = connection({
      id: "c1",
      fromBlockId: "b1",
      toBlockId: "b2",
      interface: "i2c",
      attrs: { pinAssignments: { SDA: { from: "GPIO4" }, SCL: { from: "GPIO5" } } },
    });
    const input: FirmwareInput = { projectName: "P", blocks: [mcu, sensor], connections: [conn], components: new Map() };

    const header = generatePinmapHeader(input);
    expect(header).toMatch(/#define MCU_SENSOR_I2C_SDA GPIO4 {2}\/\*/);
    expect(header).toMatch(/#define MCU_SENSOR_I2C_SCL GPIO5 {2}\/\*/);
    // ^-anchored: the header's own docstring mentions "#error" by name, only
    // a line starting with the directive itself would mean it's still there
    expect(header).not.toMatch(/^#error/m);
    expect(header).not.toMatch(/PIN NOT ASSIGNED/);
  });

  it("falls back to the `to` pin when only the to-end is stated", () => {
    const mcu = block({ id: "b1", name: "MCU" });
    const sensor = block({ id: "b2", name: "Sensor" });
    const conn = connection({
      id: "c1",
      fromBlockId: "b1",
      toBlockId: "b2",
      interface: "gpio",
      attrs: { pinAssignments: { PIN: { to: "SENSOR_PIN_3" } } },
    });
    const input: FirmwareInput = { projectName: "P", blocks: [mcu, sensor], connections: [conn], components: new Map() };

    const header = generatePinmapHeader(input);
    expect(header).toMatch(/#define MCU_SENSOR_GPIO_PIN SENSOR_PIN_3 {2}\/\*/);
    expect(header).not.toMatch(/^#error/m);
  });

  it("excludes power connections from pins.h", () => {
    const battery = block({ id: "b1", name: "Battery" });
    const mcu = block({ id: "b2", name: "MCU" });
    const conn = connection({ id: "c1", fromBlockId: "b1", toBlockId: "b2", interface: "power" });
    const input: FirmwareInput = {
      projectName: "P",
      blocks: [battery, mcu],
      connections: [conn],
      components: new Map(),
    };

    const header = generatePinmapHeader(input);
    expect(header).not.toContain("Battery");
    expect(header).not.toMatch(/^#error/m);
  });
});

describe("generatePlatformioIni", () => {
  it("leaves board and framework commented out, names the env after the project", () => {
    const input: FirmwareInput = {
      projectName: "Test Project",
      blocks: [],
      connections: [],
      components: new Map(),
    };

    const ini = generatePlatformioIni(input);
    expect(ini).toContain("[env:test-project]");
    expect(ini).toMatch(/^; board =/m);
    expect(ini).toMatch(/^; framework =/m);
    expect(ini).toContain("monitor_speed = 115200");
  });

  it("does not guess a board id even when an MCU component is bound", () => {
    const mcu = block({ id: "b1", name: "MCU", role: "mcu", componentId: "comp1" });
    const components = new Map<string, Component>([
      [
        "comp1",
        {
          id: "comp1",
          mpn: "STM32F103C8T6",
          manufacturer: "",
          description: "",
          category: "mcu",
          lifecycle: "unknown",
          specs: { absoluteMax: [], recommendedOperating: [], powerStates: [], pins: [], interfaces: [], decoupling: [], extra: {} },
          familyId: null,
          isFamily: false,
          variantAttrs: {},
          createdAt: "",
          updatedAt: "",
        },
      ],
    ]);
    const input: FirmwareInput = { projectName: "P", blocks: [mcu], connections: [], components };

    const ini = generatePlatformioIni(input);
    expect(ini).toMatch(/^; board = .*STM32F103C8T6/m);
    expect(ini).not.toMatch(/^board\s*=/m);
  });
});
