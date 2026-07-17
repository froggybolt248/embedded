import { describe, expect, it } from "vitest";
import { ExpressionError, evaluateBoolean, evaluateNumber } from "./evaluator.js";

describe("evaluateNumber", () => {
  it("does the arithmetic a calculator needs", () => {
    expect(evaluateNumber("2 + 3 * 4")).toBe(14);
    expect(evaluateNumber("(vdd - vol) / iol", { vdd: 3.3, vol: 0.4, iol: 0.003 })).toBeCloseTo(
      966.67,
      1,
    );
  });

  it("exposes the standard math functions", () => {
    expect(evaluateNumber("sqrt(16)")).toBe(4);
    expect(evaluateNumber("min(3, 7)")).toBe(3);
    expect(evaluateNumber("round(2.7)")).toBe(3);
  });

  it("rejects a non-numeric result rather than coercing it", () => {
    expect(() => evaluateNumber("true")).toThrow(ExpressionError);
  });

  it("rejects a result that is not finite", () => {
    // 1/0 is Infinity in mathjs; a rule must not silently pass on it
    expect(() => evaluateNumber("1 / 0")).toThrow(ExpressionError);
  });

  it("reports an unknown symbol instead of treating it as zero", () => {
    expect(() => evaluateNumber("nonexistent + 1")).toThrow(ExpressionError);
  });
});

describe("evaluateBoolean", () => {
  it("evaluates the comparison a rule asserts", () => {
    expect(evaluateBoolean("rpull < 1800", { rpull: 966 })).toBe(true);
    expect(evaluateBoolean("rpull < 1800", { rpull: 4700 })).toBe(false);
  });

  it("supports the boolean connectives a `when` clause needs", () => {
    expect(evaluateBoolean("isI2c and speed > 100", { isI2c: true, speed: 400 })).toBe(true);
    expect(evaluateBoolean("isI2c and speed > 100", { isI2c: false, speed: 400 })).toBe(false);
  });

  it("refuses to read a number as truthy", () => {
    // `assert: "vdd"` is a broken rule; passing it silently would hide the bug
    expect(() => evaluateBoolean("vdd", { vdd: 3.3 })).toThrow(ExpressionError);
  });
});

describe("sandbox", () => {
  // Each of these is a real escape route out of an unhardened mathjs, not a
  // hypothetical: rule expressions are authored in-app and are untrusted input.
  it.each([
    ["import", 'import({ pwn: 1 })'],
    ["createUnit", 'createUnit("pwn")'],
    ["evaluate", 'evaluate("1 + 1")'],
    ["parse", 'parse("1 + 1")'],
    ["simplify", 'simplify("x + x")'],
    ["derivative", 'derivative("x^2", "x")'],
  ])("blocks %s, which would reopen the parser or mutate global state", (_name, expr) => {
    expect(() => evaluateNumber(expr)).toThrow(ExpressionError);
  });

  it("blocks property access, the first step of a prototype climb", () => {
    expect(() => evaluateNumber('"abc".constructor')).toThrow(ExpressionError);
    expect(() => evaluateNumber("x.constructor", { x: 1 })).toThrow(ExpressionError);
  });

  it("blocks index access", () => {
    expect(() => evaluateNumber('x["constructor"]', { x: 1 })).toThrow(ExpressionError);
  });

  it("blocks defining a function", () => {
    expect(() => evaluateNumber("f(x) = 1; f(2)")).toThrow(ExpressionError);
  });

  it("blocks assignment, so one rule cannot leave state for the next", () => {
    expect(() => evaluateNumber("x = 5")).toThrow(ExpressionError);
  });

  it("does not let an expression mutate the caller's scope object", () => {
    const scope = { vdd: 3.3 };
    expect(() => evaluateNumber("vdd = 99", scope)).toThrow(ExpressionError);
    expect(scope.vdd).toBe(3.3);
  });

  it("stays blocked across evaluations", () => {
    // a successful import in one call would persist into every later one
    expect(() => evaluateNumber('import({ pwn: 1 })')).toThrow(ExpressionError);
    expect(() => evaluateNumber("pwn")).toThrow(ExpressionError);
    expect(evaluateNumber("1 + 1")).toBe(2);
  });
});
