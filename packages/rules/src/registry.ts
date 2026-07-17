import type { DesignRule, Finding, FindingStatus, FindingSubject } from "@embedded/core";
import {
  ExpressionError,
  evaluateBoolean,
  evaluateNumber,
  missingSymbols,
  type Scope,
} from "./evaluator.js";

/**
 * RuleRegistry + evaluator — the "self-updating by data, not code" seam.
 *
 * A DesignRule is a row in the database: `when` decides whether the rule applies
 * to a subject, `assert` is what must hold, and both are expressions run in the
 * sandbox. That is what lets a rule be written, edited, or LLM-drafted inside the
 * app without a release.
 *
 * `builtin: true` is the escape hatch for checks that are genuinely code — ones
 * needing iteration, table lookups, or anything an expression should not be
 * contorted into. A builtin resolves to a registered TS function instead of the
 * expressions, but it is the SAME DesignRule row with the same id, name,
 * severity and citation, so the UI, the findings drawer and the archetype
 * recipes cannot tell the two apart. That symmetry is the point: the v2 in-app
 * agent becomes just another writer of rule rows.
 */

/** A thing a rule can be checked against, with the values it may reason about. */
export interface RuleTarget {
  subject: FindingSubject;
  /**
   * Facts about this subject, already resolved to scalars. Building it is the
   * caller's job (M6 reads it off the diagram and the bound components), which
   * keeps this package free of any dependency on how a design is stored.
   */
  scope: Scope;
  /**
   * Selector attributes matched against `rule.appliesTo`. Kept separate from
   * `scope` because they are identity ("this is an i2c connection"), not
   * quantities, and a rule must not be able to do arithmetic on them.
   */
  attrs: Record<string, string>;
}

/** A builtin's verdict. `null` means the rule did not apply to this subject. */
export interface BuiltinResult {
  passed: boolean;
  /** overrides the rule's message template when present */
  message?: string;
  /** merged into the finding's scope, so a builtin shows its working too */
  scope?: Scope;
}

export type BuiltinRule = (target: RuleTarget) => BuiltinResult | null;

export class RuleRegistry {
  private readonly builtins = new Map<string, BuiltinRule>();

  register(id: string, fn: BuiltinRule): void {
    if (this.builtins.has(id)) {
      throw new Error(`builtin rule "${id}" is already registered`);
    }
    this.builtins.set(id, fn);
  }

  get(id: string): BuiltinRule | undefined {
    return this.builtins.get(id);
  }

  has(id: string): boolean {
    return this.builtins.has(id);
  }
}

/** Selector match: every attribute the rule names must equal the target's. */
function applies(rule: DesignRule, target: RuleTarget): boolean {
  return Object.entries(rule.appliesTo).every(([key, want]) => target.attrs[key] === want);
}

/**
 * Render `{expr}` placeholders in a message against the scope, so a finding can
 * state the number that provoked it ("pull-up is {rpull} Ω, above the 1.8 kΩ
 * ceiling") rather than a generic complaint.
 *
 * A placeholder that will not evaluate is left verbatim rather than erroring:
 * the finding itself is still true and useful, and losing a real warning over a
 * typo in its own message would be a bad trade.
 */
function renderMessage(template: string, scope: Scope): string {
  return template.replace(/\{([^{}]+)\}/g, (whole, expr: string) => {
    try {
      const value = evaluateNumber(expr, scope);
      return String(Number(value.toPrecision(4)));
    } catch {
      const direct = scope[expr.trim()];
      return direct === undefined ? whole : String(direct);
    }
  });
}

function finding(
  rule: DesignRule,
  target: RuleTarget,
  message: string,
  scope: Scope,
  status: FindingStatus = "failed",
  missingInputs: string[] = [],
): Finding {
  return {
    ruleId: rule.id,
    ruleName: rule.name,
    // Only a real failure carries the rule's own severity. A rule that could not
    // run has not found anything wrong with the DESIGN, and letting it inherit
    // `error` would put a red badge on a design whose only problem is that
    // nobody has typed a number yet.
    severity: status === "failed" ? rule.severity : "info",
    message,
    subject: target.subject,
    ...(rule.citation !== undefined ? { citation: rule.citation } : {}),
    scope,
    status,
    missingInputs,
  };
}

/** Renders "bus capacitance" from "busCapacitanceF" — the user never typed the identifier. */
function humanizeSymbol(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/\b(F|V|A|Hz|S|Ohms?)$/i, "")
    .trim()
    .toLowerCase();
}

/**
 * Run one rule against one target. Returns null when the rule does not apply —
 * a rule that is silent about a subject it has nothing to say about.
 *
 * A rule only produces a finding when its assertion FAILS. Passing checks are
 * not findings; a drawer that lists every satisfied rule buries the one that
 * matters.
 */
export function evaluateRule(
  rule: DesignRule,
  target: RuleTarget,
  registry: RuleRegistry,
): Finding | null {
  if (!rule.enabled) return null;
  if (!applies(rule, target)) return null;

  if (rule.builtin) {
    const fn = registry.get(rule.id);
    if (fn === undefined) {
      // A rule row marked builtin whose code is missing is a broken install, not
      // a passing check. Saying nothing here would quietly drop a check the user
      // believes is running.
      return finding(
        rule,
        target,
        `rule "${rule.name}" is marked builtin but no implementation is registered`,
        target.scope,
        "broken",
      );
    }
    let result: BuiltinResult | null;
    try {
      result = fn(target);
    } catch (err) {
      return finding(
        rule,
        target,
        `rule "${rule.name}" failed: ${err instanceof Error ? err.message : String(err)}`,
        target.scope,
        "broken",
      );
    }
    if (result === null || result.passed) return null;
    const scope = { ...target.scope, ...result.scope };
    return finding(rule, target, result.message ?? renderMessage(rule.check.message, scope), scope);
  }

  // A `when` that cannot be answered means the rule cannot even decide whether it
  // applies here, so it says nothing at all rather than reporting against a
  // subject it may have no business judging.
  if (missingSymbols(rule.check.when, target.scope).length > 0) return null;

  try {
    if (!evaluateBoolean(rule.check.when, target.scope)) return null;
  } catch (err) {
    if (!(err instanceof ExpressionError)) throw err;
    return finding(rule, target, `rule "${rule.name}" could not run: ${err.message}`, target.scope, "broken");
  }

  // The rule DOES apply here — so a value it needs and cannot get is a gap in the
  // design worth naming, not an error and not silence.
  const missing = missingSymbols(rule.check.assert, target.scope);
  if (missing.length > 0) {
    const names = missing.map(humanizeSymbol).join(", ");
    return finding(
      rule,
      target,
      `${rule.name}: enter the ${names} and this check can run`,
      target.scope,
      "needs-input",
      missing,
    );
  }

  try {
    if (evaluateBoolean(rule.check.assert, target.scope)) return null;
  } catch (err) {
    if (!(err instanceof ExpressionError)) throw err;
    // An expression that will not run is reported as broken. Treating it as a
    // pass hides the failure behind a green check, which is the one outcome a
    // verification tool must never fake.
    return finding(rule, target, `rule "${rule.name}" could not run: ${err.message}`, target.scope, "broken");
  }

  return finding(rule, target, renderMessage(rule.check.message, target.scope), target.scope);
}

/** Every finding the rule set has about these targets, most severe first. */
export function evaluateRules(
  rules: DesignRule[],
  targets: RuleTarget[],
  registry: RuleRegistry,
): Finding[] {
  const findings: Finding[] = [];
  for (const rule of rules) {
    for (const target of targets) {
      const f = evaluateRule(rule, target, registry);
      if (f !== null) findings.push(f);
    }
  }
  const bySeverity = { error: 0, warning: 1, info: 2 } as const;
  // Within a severity, a real failure outranks a check that merely wants data,
  // which outranks a rule that is itself broken — the drawer's top item should
  // always be the thing most worth the user's attention.
  const byStatus = { failed: 0, "needs-input": 1, broken: 2 } as const;
  return findings.sort(
    (a, b) => bySeverity[a.severity] - bySeverity[b.severity] || byStatus[a.status] - byStatus[b.status],
  );
}
