import { Block, Component, ComponentSpecs, Connection } from "@embedded/core";
import { evaluateRules, RuleRegistry, type RuleTarget } from "@embedded/rules";
import { describe, expect, it } from "vitest";
import { buildRuleTargets, type DesignSnapshot } from "./services/rule-targets.js";

const src = (page: number) => ({
  kind: "datasheet" as const,
  datasheetId: "ds1",
  page,
  snippet: "row",
  verifiedBy: "machine" as const,
});

const volts = (value: number, unit = "V") => ({ value, unit, source: src(8) });

function component(over: { id: string; specs?: unknown; lifecycle?: string }): Component {
  return Component.parse({
    id: over.id,
    mpn: over.id,
    manufacturer: "ACME",
    description: "",
    category: "sensor",
    lifecycle: over.lifecycle ?? "active",
    specs: ComponentSpecs.parse(over.specs ?? {}),
    familyId: null,
    isFamily: false,
    variantAttrs: {},
    createdAt: "2026-07-17T00:00:00Z",
    updatedAt: "2026-07-17T00:00:00Z",
  });
}

function block(id: string, name: string, componentId: string | null = null): Block {
  return Block.parse({ id, projectId: "p1", name, role: "sensor", componentId });
}

function connection(over: Partial<Connection> & { id: string }): Connection {
  return Connection.parse({
    projectId: "p1",
    fromBlockId: "b1",
    toBlockId: "b2",
    interface: "i2c",
    ...over,
  });
}

function snapshot(over: Partial<DesignSnapshot> = {}): DesignSnapshot {
  return {
    projectId: "p1",
    projectName: "Golden e-ink weather station",
    blocks: [],
    connections: [],
    components: new Map(),
    ...over,
  };
}

function scopeOf(targets: RuleTarget[], id: string): Record<string, number | boolean> {
  return targets.find((t) => t.subject.id === id)?.scope ?? {};
}

describe("buildRuleTargets", () => {
  it("puts the subject kind in attrs, so a rule can select what it judges", () => {
    const targets = buildRuleTargets(
      snapshot({ blocks: [block("b1", "MCU")], connections: [connection({ id: "c1" })] }),
    );
    expect(targets.map((t) => t.attrs["kind"])).toEqual(["project", "block", "connection"]);
  });

  it("reads a bound part's supply window and absolute maximum off its grounded specs", () => {
    const mcu = component({
      id: "cmp1",
      specs: {
        recommendedOperating: [
          { param: "vdd", label: "Supply voltage", range: { min: volts(1.71), max: volts(3.6) } },
        ],
        absoluteMax: [{ param: "vdd", label: "Supply voltage", range: { max: volts(4.25) } }],
      },
    });
    const targets = buildRuleTargets(
      snapshot({
        blocks: [block("b1", "Sensor", "cmp1")],
        components: new Map([["cmp1", mcu]]),
      }),
    );
    expect(scopeOf(targets, "b1")).toMatchObject({ vddMinV: 1.71, vddMaxV: 3.6, absMaxVddV: 4.25 });
  });

  it("derives a block's rail from the power connection feeding it", () => {
    const targets = buildRuleTargets(
      snapshot({
        blocks: [block("b1", "Regulator"), block("b2", "Sensor")],
        connections: [connection({ id: "c1", interface: "power", attrs: { voltage: 3.3 } })],
      }),
    );
    expect(scopeOf(targets, "b2")["railV"]).toBe(3.3);
    // the source of the power is not itself fed by it
    expect(scopeOf(targets, "b1")["railV"]).toBeUndefined();
  });

  it("takes the highest rail when a block is fed by more than one", () => {
    // a part must survive the worst rail it can see, not the average
    const targets = buildRuleTargets(
      snapshot({
        blocks: [block("b1", "5V"), block("b2", "3V3"), block("b3", "Part")],
        connections: [
          connection({ id: "c1", interface: "power", fromBlockId: "b1", toBlockId: "b3", attrs: { voltage: 5 } }),
          connection({ id: "c2", interface: "power", fromBlockId: "b2", toBlockId: "b3", attrs: { voltage: 3.3 } }),
        ],
      }),
    );
    expect(scopeOf(targets, "b3")["railV"]).toBe(5);
  });

  it("converts mV to volts and refuses an unrecognised unit", () => {
    const inMillivolts = component({
      id: "c1",
      specs: {
        recommendedOperating: [{ param: "vdd", label: "Supply", range: { min: volts(1710, "mV") } }],
        absoluteMax: [{ param: "vdd", label: "Supply", range: { max: volts(4.25, "furlongs") } }],
      },
    });
    const targets = buildRuleTargets(
      snapshot({ blocks: [block("b1", "S", "c1")], components: new Map([["c1", inMillivolts]]) }),
    );
    expect(scopeOf(targets, "b1")["vddMinV"]).toBeCloseTo(1.71, 6);
    // a unit we cannot read is NOT silently treated as volts — that number would
    // go straight into an absolute-maximum comparison
    expect(scopeOf(targets, "b1")["absMaxVddV"]).toBeUndefined();
  });
});

describe("what the design has not said yet", () => {
  it("leaves bus capacitance and pull-up absent rather than defaulting them", () => {
    const targets = buildRuleTargets(
      snapshot({
        blocks: [block("b1", "MCU"), block("b2", "Sensor")],
        connections: [connection({ id: "c1", attrs: { voltage: 3.3, busSpeedHz: 400_000 } })],
      }),
    );
    const scope = scopeOf(targets, "c1");
    expect(scope["railV"]).toBe(3.3);
    // a default here would silently decide whether the bus is in spec
    expect(scope["busCapacitanceF"]).toBeUndefined();
    expect(scope["rpullOhms"]).toBeUndefined();
  });

  it("leaves the receiver's VIH absent when the part does not document one", () => {
    // the whole 3.3→5 V trap is that VIH is NOT derivable from the rail
    const targets = buildRuleTargets(
      snapshot({
        blocks: [block("b1", "MCU"), block("b2", "Sensor", "c2")],
        components: new Map([["c2", component({ id: "c2" })]]),
        connections: [connection({ id: "c1", attrs: { voltage: 3.3 } })],
      }),
    );
    expect(scopeOf(targets, "c1")["toVihV"]).toBeUndefined();
  });

  it("uses the designer's stated bus voltage as the driver high, but a real VOH outranks it", () => {
    const driver = component({
      id: "drv",
      specs: {
        recommendedOperating: [{ param: "voh", label: "Output high", range: { min: volts(2.4) } }],
      },
    });
    const stated = buildRuleTargets(
      snapshot({
        blocks: [block("b1", "MCU"), block("b2", "S")],
        connections: [connection({ id: "c1", attrs: { voltage: 3.3 } })],
      }),
    );
    expect(scopeOf(stated, "c1")["fromHighV"]).toBe(3.3);

    const documented = buildRuleTargets(
      snapshot({
        blocks: [block("b1", "MCU", "drv"), block("b2", "S")],
        components: new Map([["drv", driver]]),
        connections: [connection({ id: "c1", attrs: { voltage: 3.3 } })],
      }),
    );
    expect(scopeOf(documented, "c1")["fromHighV"]).toBe(2.4);
  });

  it("reads the receiver's pin rating from vddio, not from its supply rating", () => {
    const rx = component({
      id: "rx",
      specs: {
        absoluteMax: [
          { param: "vdd", label: "Supply voltage", range: { max: volts(4.25) } },
          { param: "vddio", label: "Voltage at any interface pin", range: { max: volts(4.0) } },
        ],
      },
    });
    const targets = buildRuleTargets(
      snapshot({
        blocks: [block("b1", "MCU"), block("b2", "Sensor", "rx")],
        components: new Map([["rx", rx]]),
        connections: [connection({ id: "c1", attrs: { voltage: 3.3 } })],
      }),
    );
    // 4.0 (the pin), never 4.25 (the supply)
    expect(scopeOf(targets, "c1")["toAbsMaxV"]).toBe(4.0);
  });
});

describe("the seeded rules against a real design", () => {
  const registry = new RuleRegistry();

  it("catches a 5 V bus driving a part rated to 4 V on its pins", () => {
    const rule = {
      id: "level-shift-overvoltage",
      name: "Logic high exceeds the receiver's absolute maximum",
      description: "",
      severity: "error" as const,
      appliesTo: { kind: "connection" },
      check: { when: "true", assert: "fromHighV <= toAbsMaxV", message: "{fromHighV} V into a {toAbsMaxV} V pin" },
      enabled: true,
      builtin: false,
      createdAt: "2026-07-17T00:00:00Z",
      updatedAt: "2026-07-17T00:00:00Z",
    };
    const rx = component({
      id: "rx",
      specs: { absoluteMax: [{ param: "vddio", label: "Voltage at any interface pin", range: { max: volts(4.0) } }] },
    });
    const targets = buildRuleTargets(
      snapshot({
        blocks: [block("b1", "MCU"), block("b2", "Sensor", "rx")],
        components: new Map([["rx", rx]]),
        connections: [connection({ id: "c1", attrs: { voltage: 5 } })],
      }),
    );
    const findings = evaluateRules([rule], targets, registry);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.severity).toBe("error");
    expect(findings[0]?.message).toBe("5 V into a 4 V pin");
    expect(findings[0]?.subject.label).toBe("MCU → Sensor (i2c)");
  });

  it("asks for the bus capacitance instead of guessing whether the pull-up is legal", () => {
    const rule = {
      id: "i2c-pullup-too-weak",
      name: "I²C pull-up too weak for the bus speed",
      description: "",
      severity: "warning" as const,
      appliesTo: { interface: "i2c", i2cMode: "fast" },
      check: {
        when: "true",
        assert: "rpullOhms * busCapacitanceF <= 300e-9 / 0.8473",
        message: "too weak",
      },
      enabled: true,
      builtin: false,
      createdAt: "2026-07-17T00:00:00Z",
      updatedAt: "2026-07-17T00:00:00Z",
    };
    const targets = buildRuleTargets(
      snapshot({
        blocks: [block("b1", "MCU"), block("b2", "Sensor")],
        connections: [connection({ id: "c1", attrs: { voltage: 3.3, busSpeedHz: 400_000 } })],
      }),
    );
    const findings = evaluateRules([rule], targets, registry);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.status).toBe("needs-input");
    expect(findings[0]?.missingInputs?.sort()).toEqual(["busCapacitanceF", "rpullOhms"]);
    // a check that merely wants data must not paint the design red
    expect(findings[0]?.severity).toBe("info");
  });

  it("fires the 400 kHz pull-up rule once the design says enough, and not at 100 kHz", () => {
    const rule = {
      id: "i2c-pullup-too-weak",
      name: "I²C pull-up too weak",
      description: "",
      severity: "warning" as const,
      appliesTo: { interface: "i2c", i2cMode: "fast" },
      check: {
        when: "true",
        assert: "rpullOhms * busCapacitanceF <= 300e-9 / 0.8473",
        message: "{rpullOhms} Ω is too weak",
      },
      enabled: true,
      builtin: false,
      createdAt: "2026-07-17T00:00:00Z",
      updatedAt: "2026-07-17T00:00:00Z",
    };
    const attrs = { voltage: 3.3, busCapacitanceF: 200e-12, pullupOhms: 4700 };

    // 400 kHz: the copied-everywhere 4.7 kΩ is out of spec
    const fast = buildRuleTargets(
      snapshot({
        blocks: [block("b1", "MCU"), block("b2", "S")],
        connections: [connection({ id: "c1", attrs: { ...attrs, busSpeedHz: 400_000 } })],
      }),
    );
    const fastFindings = evaluateRules([rule], fast, registry);
    expect(fastFindings).toHaveLength(1);
    expect(fastFindings[0]?.message).toBe("4700 Ω is too weak");

    // 100 kHz: same resistor, genuinely fine — the selector excludes it
    const slow = buildRuleTargets(
      snapshot({
        blocks: [block("b1", "MCU"), block("b2", "S")],
        connections: [connection({ id: "c1", attrs: { ...attrs, busSpeedHz: 100_000 } })],
      }),
    );
    expect(evaluateRules([rule], slow, registry)).toHaveLength(0);
  });
});
