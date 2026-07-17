import type {
  Block,
  Component,
  ComponentSpecs,
  Connection,
  RatedParam,
  SourcedRange,
} from "@embedded/core";
import { i2cModeForSpeed } from "@embedded/calc";
import type { RuleTarget, Scope } from "@embedded/rules";

/**
 * Turn a real design into the subjects the rule engine judges.
 *
 * This is the seam the whole Electrical phase turns on, and it is deliberately a
 * PURE function over plain domain objects: the rule engine must not know how a
 * design is stored, and this must be testable without a database or a browser.
 *
 * Its one job is to be honest about what is known. Every value below either
 * comes from a grounded datasheet row or from something the designer explicitly
 * stated; nothing is inferred to fill a gap. A scope value that is simply absent
 * makes the rule report "needs input" and name the fact it wants — which is the
 * app teaching, and is strictly better than a default that silently decides
 * whether the design passes. This is the same rule that governs extraction: a
 * missing number must stay missing.
 */

/** Volts from V / mV / kV. Unknown units are left alone rather than scaled wrongly. */
function toVolts(value: number, unit: string): number | undefined {
  const u = unit.replace(/\s+/g, "").toLowerCase();
  if (u === "v") return value;
  if (u === "mv") return value / 1000;
  if (u === "kv") return value * 1000;
  // An unrecognised unit is not a volt. Guessing here would put a wrong number
  // into an absolute-maximum comparison, which is the one place to be sure.
  return undefined;
}

type Bound = "min" | "typ" | "max";

/** One bound of a rated param, in volts, if the part documents it as a number. */
function ratedVolts(rows: RatedParam[], param: string, bound: Bound): number | undefined {
  const row = rows.find((r) => r.param === param);
  if (row === undefined) return undefined;
  const sv = (row.range as SourcedRange)[bound];
  if (sv === undefined) return undefined;
  return toVolts(sv.value, sv.unit);
}

/**
 * The voltage the designer says this connection runs at.
 *
 * Used as the driver's logic-high when the part documents no VOH of its own: a
 * push-pull CMOS output drives essentially to its rail, and — this is the point —
 * the number came from the DESIGNER, who stated "this is a 3.3 V bus". That is
 * user input, not an invention. A part's own VOH still outranks it.
 */
function statedVoltage(c: Connection): number | undefined {
  return c.attrs.voltage;
}

function specsOf(component: Component | undefined): ComponentSpecs | undefined {
  return component?.specs;
}

/** Add a key only when it has a value — an absent key is what triggers "needs input". */
function put(scope: Scope, key: string, value: number | boolean | undefined): void {
  if (value !== undefined) scope[key] = value;
}

export interface DesignSnapshot {
  projectId: string;
  projectName: string;
  blocks: Block[];
  connections: Connection[];
  /** bound components by id */
  components: Map<string, Component>;
  /**
   * The computed power budget, when one exists. Passed as plain numbers rather
   * than importing the calculator's result type, so this stays a data mapping.
   */
  budget?: {
    estimatedLifeYears: number;
    avgCurrentMa: number;
    batteryMah: number;
  };
  /** the archetype's stated goal, when the project has one */
  targetLifeYears?: number;
}

/**
 * The rail feeding a block: the voltage of a `power` connection INTO it.
 *
 * Voltage domains are not modelled as a first-class thing yet, and inventing one
 * per block would be worse than deriving it: the design already says where power
 * comes from, and if it does not, the honest answer is that the rail is unknown
 * and the supply checks cannot run. Multiple power feeds take the highest — a
 * part must survive the worst rail it can see, not the average of them.
 */
function railFor(blockId: string, connections: Connection[]): number | undefined {
  const volts = connections
    .filter((c) => c.interface === "power" && c.toBlockId === blockId)
    .map(statedVoltage)
    .filter((v): v is number => v !== undefined);
  return volts.length > 0 ? Math.max(...volts) : undefined;
}

function blockTarget(
  block: Block,
  snapshot: DesignSnapshot,
): RuleTarget {
  const component = block.componentId ? snapshot.components.get(block.componentId) : undefined;
  const specs = specsOf(component);
  const scope: Scope = {};

  put(scope, "railV", railFor(block.id, snapshot.connections));
  if (specs) {
    put(scope, "vddMinV", ratedVolts(specs.recommendedOperating, "vdd", "min"));
    put(scope, "vddMaxV", ratedVolts(specs.recommendedOperating, "vdd", "max"));
    put(scope, "absMaxVddV", ratedVolts(specs.absoluteMax, "vdd", "max"));
  }

  return {
    subject: { kind: "block", id: block.id, label: block.name },
    scope,
    attrs: {
      // `kind` is in attrs so a rule can select its subject type the same way it
      // selects anything else. Without it `appliesTo: {}` matches every subject
      // in the design, and a connection rule asks every block for a bus voltage.
      kind: "block",
      role: block.role,
      bound: component ? "yes" : "no",
      ...(component !== undefined ? { lifecycle: component.lifecycle } : {}),
    },
  };
}

function connectionTarget(
  connection: Connection,
  snapshot: DesignSnapshot,
): RuleTarget {
  const byId = new Map(snapshot.blocks.map((b) => [b.id, b]));
  const from = byId.get(connection.fromBlockId);
  const to = byId.get(connection.toBlockId);
  const fromComponent = from?.componentId ? snapshot.components.get(from.componentId) : undefined;
  const toComponent = to?.componentId ? snapshot.components.get(to.componentId) : undefined;
  const fromSpecs = specsOf(fromComponent);
  const toSpecs = specsOf(toComponent);

  const scope: Scope = {};
  const rail = statedVoltage(connection);
  put(scope, "railV", rail);
  put(scope, "busSpeedHz", connection.attrs.busSpeedHz);
  put(scope, "busCapacitanceF", connection.attrs.busCapacitanceF);
  put(scope, "rpullOhms", connection.attrs.pullupOhms);

  // The driver's guaranteed high: its own VOH if the datasheet states one,
  // otherwise the rail the designer put this bus on.
  const voh = fromSpecs ? ratedVolts(fromSpecs.recommendedOperating, "voh", "min") : undefined;
  put(scope, "fromHighV", voh ?? rail);

  // The receiver's input-high threshold. No fallback: a part that does not
  // document VIH leaves this check unrun and says so, because the whole 3.3→5 V
  // trap is that the answer is NOT derivable from the rail.
  put(scope, "toVihV", toSpecs ? ratedVolts(toSpecs.recommendedOperating, "vih", "min") : undefined);

  // `vddio` is the canonical id for "voltage at any interface pin" (see
  // canonical.ts BY_LABEL) — the pin's own rating, not the supply's. Using the
  // supply's absolute max in its place would be plausible and wrong.
  put(scope, "toAbsMaxV", toSpecs ? ratedVolts(toSpecs.absoluteMax, "vddio", "max") : undefined);

  const label = `${from?.name ?? "?"} → ${to?.name ?? "?"} (${connection.interface})`;
  const speed = connection.attrs.busSpeedHz;

  return {
    subject: { kind: "connection", id: connection.id, label },
    scope,
    attrs: {
      kind: "connection",
      interface: connection.interface,
      // The mode decides which rise-time limit applies, so it is identity rather
      // than a quantity — a rule selects on it, it does not do arithmetic on it.
      ...(connection.interface === "i2c" && speed !== undefined
        ? { i2cMode: i2cModeForSpeed(speed) }
        : {}),
    },
  };
}

function projectTarget(snapshot: DesignSnapshot): RuleTarget {
  const scope: Scope = {};
  if (snapshot.budget) {
    put(scope, "estimatedLifeYears", snapshot.budget.estimatedLifeYears);
    put(scope, "avgCurrentUa", snapshot.budget.avgCurrentMa * 1000);
    put(scope, "batteryMah", snapshot.budget.batteryMah);
  }
  put(scope, "targetLifeYears", snapshot.targetLifeYears);

  return {
    subject: { kind: "project", id: snapshot.projectId, label: snapshot.projectName },
    scope,
    attrs: { kind: "project" },
  };
}

/** Every subject in a design, in the order a findings drawer should read them. */
export function buildRuleTargets(snapshot: DesignSnapshot): RuleTarget[] {
  return [
    projectTarget(snapshot),
    ...snapshot.blocks.map((b) => blockTarget(b, snapshot)),
    ...snapshot.connections.map((c) => connectionTarget(c, snapshot)),
  ];
}
