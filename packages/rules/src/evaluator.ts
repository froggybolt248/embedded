import { create, all, type FactoryFunctionMap, type MathJsInstance } from "mathjs";

/**
 * Sandboxed expression evaluator — the execution engine behind data-defined
 * rules and calculators.
 *
 * Rules and calculators are DATA (user decision 3: the app extends by data, not
 * code), which means their expressions are authored in-app, by a person or by an
 * LLM, and then run here. That is the whole point and also the whole risk: an
 * expression string is untrusted input, and mathjs out of the box is a general
 * programming language with a filesystem-reaching `import`.
 *
 * So the surface is closed deliberately rather than hopefully:
 *
 * - `import` / `createUnit` would let an expression define new globals that
 *   persist into every later evaluation, including other projects' rules.
 * - `evaluate` / `parse` re-open the parser from inside the sandbox, which
 *   makes every other restriction here bypassable in one hop.
 * - `simplify` / `derivative` / `rationalize` accept expression strings too, and
 *   reach the same parser by a longer road. They are not needed to state a
 *   design rule.
 * - Function assignment (`f(x) = ...`) and object/index access are rejected at
 *   the AST, before evaluation: property access is how a sandboxed expression
 *   climbs to the prototype chain and out.
 *
 * The result is deliberately small: arithmetic, comparison, the standard math
 * functions and units. That is enough to say "the pull-up must be under 1.8 kΩ"
 * and nothing more, which is exactly the intent.
 */

/** Names whose mathjs implementations can reach the parser, the filesystem, or global state. */
const FORBIDDEN_NAMES = new Set([
  "import",
  "createUnit",
  "evaluate",
  "parse",
  "compile",
  "simplify",
  "derivative",
  "rationalize",
  "resolve",
  "help",
  "chain",
]);

/**
 * The names are rejected in the AST rather than overridden on the instance.
 *
 * Overriding looks tempting — `math.import({ evaluate: throws }, {override:true})`
 * — and it is a trap twice over. It breaks the host: this module calls
 * `math.evaluate` itself, and the override blocks that too, so every legitimate
 * expression dies alongside the malicious one. And it does not reliably block
 * the guest: mathjs wires `parse` into `evaluate` through closures captured when
 * the instance is built, so replacing the namespace entry can leave the original
 * reachable from inside while breaking the public surface.
 *
 * Rejecting at the AST is both stricter and simpler: a forbidden name never
 * reaches evaluation at all, and mathjs itself is left exactly as its authors
 * built it.
 */
// mathjs types `all` as optionally undefined; it never is.
const math: MathJsInstance = create(all as FactoryFunctionMap, {});

/** AST node types that read properties off a value, or define new callables. */
const FORBIDDEN_NODES = new Set([
  "AccessorNode", // a.b  — the first step of a prototype climb
  "IndexNode", // a["b"]
  "ObjectNode",
  "FunctionAssignmentNode", // f(x) = ...
  "AssignmentNode", // x = ...  — a rule states a fact, it does not mutate scope
]);

export class ExpressionError extends Error {}

/**
 * The symbols an expression reads that the scope cannot supply.
 *
 * This is what separates "this rule is broken" from "this design has not told
 * me enough yet" — two states that a bare throw collapses into one. An I²C
 * pull-up rule needs the bus capacitance; until someone enters it the rule is
 * perfectly well-formed and simply cannot run. Reporting that as an error cries
 * wolf on every connection, and reporting it as a pass hides a real check that
 * never happened. Neither is acceptable, so the caller gets the list and can say
 * "tell me the bus capacitance and I'll check your pull-ups" — which is the
 * teaching surface this app exists to be, not an error state.
 *
 * mathjs's own names (`pi`, `e`, and every builtin function) are not missing —
 * they resolve from the instance, not the scope.
 */
export function missingSymbols(expr: string, scope: Scope): string[] {
  let ast;
  try {
    ast = math.parse(expr);
  } catch {
    // a malformed expression is a different failure; let evaluation report it
    return [];
  }
  const missing = new Set<string>();
  ast.traverse((node, path, parent) => {
    if (node.type !== "SymbolNode") return;
    // a call's callee parses as a SymbolNode too ("sqrt" in "sqrt(x)")
    if (parent?.type === "FunctionNode" && path === "fn") return;
    const name = (node as unknown as { name: string }).name;
    if (name in scope) return;
    if ((math as unknown as Record<string, unknown>)[name] !== undefined) return;
    missing.add(name);
  });
  return [...missing];
}

/**
 * Values an expression may be evaluated against. Numbers and booleans only:
 * a scope carrying objects would reintroduce the property access the AST check
 * exists to forbid, and every quantity a rule reasons about is already scalar.
 */
export type Scope = Record<string, number | boolean>;

function assertSafeAst(expr: string): void {
  let ast;
  try {
    ast = math.parse(expr);
  } catch (err) {
    throw new ExpressionError(
      `could not parse: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  ast.traverse((node) => {
    if (FORBIDDEN_NODES.has(node.type)) {
      throw new ExpressionError(`${node.type} is not allowed in a design-rule expression`);
    }
    // Both forms are checked: `import(...)` parses as a FunctionNode, but a bare
    // `import` is a SymbolNode that hands back the function itself, and a scope
    // holding a live mathjs builtin is the same escape one step later.
    const name =
      node.type === "FunctionNode"
        ? (node as unknown as { fn?: { name?: string } }).fn?.name
        : node.type === "SymbolNode"
          ? (node as unknown as { name?: string }).name
          : undefined;
    if (name !== undefined && FORBIDDEN_NAMES.has(name)) {
      throw new ExpressionError(`"${name}" is not available in a design-rule expression`);
    }
  });
}

/**
 * Evaluate an expression to a number. Throws ExpressionError rather than
 * returning a sentinel: a rule whose expression is broken must be reported as
 * broken, never silently treated as passing.
 */
export function evaluateNumber(expr: string, scope: Scope = {}): number {
  const value = evaluateRaw(expr, scope);
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ExpressionError(`expected a finite number, got ${describe(value)}`);
  }
  return value;
}

/**
 * Evaluate an expression to a boolean — the form a rule's `when` and `assert`
 * take. A non-boolean result is an error rather than a truthiness coercion: a
 * rule that says `assert: "vdd"` has a bug, and quietly reading a voltage as
 * "true" would hide it behind a passing check.
 */
export function evaluateBoolean(expr: string, scope: Scope = {}): boolean {
  const value = evaluateRaw(expr, scope);
  if (typeof value !== "boolean") {
    throw new ExpressionError(`expected true or false, got ${describe(value)}`);
  }
  return value;
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === "number") return `the number ${value}`;
  return `a ${typeof value}`;
}

function evaluateRaw(expr: string, scope: Scope): unknown {
  assertSafeAst(expr);
  // a COPY of the scope: mathjs writes to the object it is handed, and a rule
  // must not be able to leave anything behind for the next rule to read
  const local: Record<string, unknown> = { ...scope };
  try {
    return math.evaluate(expr, local);
  } catch (err) {
    if (err instanceof ExpressionError) throw err;
    throw new ExpressionError(err instanceof Error ? err.message : String(err));
  }
}
