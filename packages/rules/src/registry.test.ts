import { DesignRule } from "@embedded/core";
import { describe, expect, it } from "vitest";
import { RuleRegistry, evaluateRule, evaluateRules, type RuleTarget } from "./registry.js";

function rule(over: Partial<DesignRule> & { id: string }): DesignRule {
  return DesignRule.parse({
    name: over.id,
    check: { when: "true", assert: "true", message: "failed" },
    createdAt: "2026-07-17T00:00:00Z",
    updatedAt: "2026-07-17T00:00:00Z",
    ...over,
  });
}

function target(over: Partial<RuleTarget> = {}): RuleTarget {
  return {
    subject: { kind: "connection", id: "c1", label: "MCU → Sensor (i2c)" },
    scope: {},
    attrs: {},
    ...over,
  };
}

const empty = new RuleRegistry();

describe("evaluateRule", () => {
  it("says nothing when the assertion holds", () => {
    const r = rule({ id: "pullup", check: { when: "true", assert: "rpull < 1800", message: "too weak" } });
    expect(evaluateRule(r, target({ scope: { rpull: 966 } }), empty)).toBeNull();
  });

  it("reports a finding when the assertion fails", () => {
    const r = rule({
      id: "pullup",
      severity: "error",
      citation: "I²C spec UM10204 §7.1",
      check: { when: "true", assert: "rpull < 1800", message: "pull-up is {rpull} Ω" },
    });
    const f = evaluateRule(r, target({ scope: { rpull: 4700 } }), empty);
    expect(f?.severity).toBe("error");
    expect(f?.message).toBe("pull-up is 4700 Ω");
    expect(f?.citation).toBe("I²C spec UM10204 §7.1");
    // the finding carries the numbers it judged on, not just its verdict
    expect(f?.scope).toEqual({ rpull: 4700 });
    expect(f?.status).toBe("failed");
  });

  it("stays silent when `when` excludes the subject", () => {
    const r = rule({
      id: "fast-mode-only",
      check: { when: "speed > 100000", assert: "rpull < 1800", message: "too weak" },
    });
    expect(evaluateRule(r, target({ scope: { speed: 100000, rpull: 4700 } }), empty)).toBeNull();
  });

  it("skips a rule whose selector does not match the subject", () => {
    const r = rule({ id: "i2c-only", appliesTo: { interface: "i2c" }, check: { when: "true", assert: "false", message: "x" } });
    expect(evaluateRule(r, target({ attrs: { interface: "spi" } }), empty)).toBeNull();
    expect(evaluateRule(r, target({ attrs: { interface: "i2c" } }), empty)).not.toBeNull();
  });

  it("skips a disabled rule", () => {
    const r = rule({ id: "off", enabled: false, check: { when: "true", assert: "false", message: "x" } });
    expect(evaluateRule(r, target(), empty)).toBeNull();
  });

  it("leaves an unresolvable message placeholder verbatim rather than losing the finding", () => {
    const r = rule({ id: "typo", check: { when: "true", assert: "false", message: "value is {nosuchvar}" } });
    const f = evaluateRule(r, target(), empty);
    expect(f?.message).toBe("value is {nosuchvar}");
  });
});

describe("a rule that cannot run", () => {
  // The governing invariant: a check that fails to run must never look like a
  // check that passed.
  it("reports a broken expression instead of passing silently", () => {
    const r = rule({ id: "bad", check: { when: "true", assert: "rpull <", message: "x" } });
    const f = evaluateRule(r, target({ scope: { rpull: 1 } }), empty);
    expect(f?.status).toBe("broken");
    expect(f?.message).toContain("could not run");
  });

  it("reports a builtin whose implementation is not registered", () => {
    const r = rule({ id: "ghost", builtin: true });
    const f = evaluateRule(r, target(), empty);
    expect(f?.status).toBe("broken");
    expect(f?.message).toContain("no implementation is registered");
  });

  it("reports a builtin that throws", () => {
    const registry = new RuleRegistry();
    registry.register("boom", () => {
      throw new Error("divide by zero");
    });
    const f = evaluateRule(rule({ id: "boom", builtin: true }), target(), registry);
    expect(f?.status).toBe("broken");
    expect(f?.message).toContain("divide by zero");
  });

  it("never lets a rule that could not run wear the rule's own severity", () => {
    // an `error` rule that merely lacks data must not paint the design red
    const r = rule({ id: "sev", severity: "error", check: { when: "true", assert: "busCapacitanceF < 1", message: "x" } });
    expect(evaluateRule(r, target(), empty)?.severity).toBe("info");
  });
});

describe("a rule the design has not fed yet", () => {
  // The distinction that keeps the drawer honest: the rule is fine, the DESIGN
  // has not said enough. Reporting this as broken cries wolf on every
  // incomplete design; reporting nothing hides a check that never ran.
  it("asks for the missing value instead of erroring or passing", () => {
    const r = rule({
      id: "i2c-pullup",
      severity: "warning",
      check: { when: "true", assert: "busCapacitanceF < 400e-12", message: "bus too capacitive" },
    });
    const f = evaluateRule(r, target(), empty);
    expect(f?.status).toBe("needs-input");
    expect(f?.missingInputs).toEqual(["busCapacitanceF"]);
    // named in words the user recognises, not as the identifier
    expect(f?.message).toContain("bus capacitance");
  });

  it("says nothing at all when it cannot even tell whether it applies", () => {
    // `when` unanswerable → the rule has no business judging this subject
    const r = rule({ id: "guarded", check: { when: "isI2c", assert: "rpull < 1800", message: "x" } });
    expect(evaluateRule(r, target({ scope: { rpull: 4700 } }), empty)).toBeNull();
  });

  it("does not mistake mathjs's own constants for missing inputs", () => {
    const r = rule({ id: "consts", check: { when: "true", assert: "r > 2 * pi", message: "x" } });
    const f = evaluateRule(r, target({ scope: { r: 1 } }), empty);
    expect(f?.status).toBe("failed"); // ran fine; 1 is not > 2π
  });

  it("does not mistake a called function for a missing input", () => {
    const r = rule({ id: "fn", check: { when: "true", assert: "sqrt(x) > 5", message: "x" } });
    const f = evaluateRule(r, target({ scope: { x: 4 } }), empty);
    expect(f?.status).toBe("failed");
  });

  it("lists every missing value at once, so the user fixes them in one pass", () => {
    const r = rule({ id: "multi", check: { when: "true", assert: "a + b < c", message: "x" } });
    const f = evaluateRule(r, target({ scope: { c: 1 } }), empty);
    expect(f?.missingInputs?.sort()).toEqual(["a", "b"]);
  });
});

describe("builtin rules", () => {
  it("resolves to the registered function and can show its own working", () => {
    const registry = new RuleRegistry();
    registry.register("level-shift", (t) => {
      const from = t.scope["fromVoltage"] as number;
      const to = t.scope["toVoltage"] as number;
      if (from === to) return null; // does not apply
      return { passed: false, message: `${from} V drives ${to} V`, scope: { delta: from - to } };
    });
    const r = rule({ id: "level-shift", builtin: true, severity: "error" });

    expect(evaluateRule(r, target({ scope: { fromVoltage: 3.3, toVoltage: 3.3 } }), registry)).toBeNull();

    const f = evaluateRule(r, target({ scope: { fromVoltage: 5, toVoltage: 3.3 } }), registry);
    expect(f?.message).toBe("5 V drives 3.3 V");
    expect(f?.scope["delta"]).toBeCloseTo(1.7);
    expect(f?.severity).toBe("error");
  });

  it("looks identical to an expression rule in the finding it produces", () => {
    const registry = new RuleRegistry();
    registry.register("as-builtin", () => ({ passed: false }));
    const asBuiltin = rule({ id: "as-builtin", name: "Same check", builtin: true, check: { when: "true", assert: "false", message: "same message" } });
    const asExpression = rule({ id: "as-expression", name: "Same check", check: { when: "true", assert: "false", message: "same message" } });

    const a = evaluateRule(asBuiltin, target(), registry);
    const b = evaluateRule(asExpression, target(), registry);
    expect(a?.message).toBe(b?.message);
    expect(a?.ruleName).toBe(b?.ruleName);
    expect(a?.severity).toBe(b?.severity);
  });

  it("refuses to register the same builtin id twice", () => {
    const registry = new RuleRegistry();
    registry.register("dup", () => null);
    expect(() => registry.register("dup", () => null)).toThrow();
  });
});

describe("evaluateRules", () => {
  it("orders findings most severe first", () => {
    const rules = [
      rule({ id: "a", severity: "info", check: { when: "true", assert: "false", message: "info" } }),
      rule({ id: "b", severity: "error", check: { when: "true", assert: "false", message: "error" } }),
      rule({ id: "c", severity: "warning", check: { when: "true", assert: "false", message: "warning" } }),
    ];
    const findings = evaluateRules(rules, [target()], empty);
    expect(findings.map((f) => f.severity)).toEqual(["error", "warning", "info"]);
  });

  it("puts a real failure above a check that is merely waiting for data", () => {
    const rules = [
      rule({ id: "waiting", check: { when: "true", assert: "unknownThing > 1", message: "x" } }),
      rule({ id: "real", severity: "info", check: { when: "true", assert: "false", message: "actually wrong" } }),
    ];
    const findings = evaluateRules(rules, [target()], empty);
    expect(findings.map((f) => f.status)).toEqual(["failed", "needs-input"]);
  });

  it("checks every rule against every target", () => {
    const rules = [rule({ id: "r", check: { when: "true", assert: "v < 4", message: "{v} too high" } })];
    const targets = [
      target({ subject: { kind: "block", id: "b1", label: "MCU" }, scope: { v: 5 } }),
      target({ subject: { kind: "block", id: "b2", label: "Sensor" }, scope: { v: 3 } }),
    ];
    const findings = evaluateRules(rules, targets, empty);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.subject.id).toBe("b1");
    expect(findings[0]?.message).toBe("5 too high");
  });
});
