import { eq } from "drizzle-orm";
import { nanoid } from "nanoid";
import { Calculator, CalculatorRun } from "@embedded/core";
import type { Db } from "../client.js";
import { calculators, calculatorRuns } from "../schema.js";

function rowToCalculator(row: typeof calculators.$inferSelect): Calculator {
  return Calculator.parse({
    ...row,
    inputs: typeof row.inputs === "string" ? JSON.parse(row.inputs) : row.inputs,
    formula: typeof row.formula === "string" ? JSON.parse(row.formula) : row.formula,
    outputs: typeof row.outputs === "string" ? JSON.parse(row.outputs) : row.outputs,
    // DB column is nullable text; core schema wants `undefined` (optional), not `null`.
    citation: row.citation ?? undefined,
  });
}

function rowToCalculatorRun(row: typeof calculatorRuns.$inferSelect): CalculatorRun {
  return CalculatorRun.parse({
    ...row,
    projectId: row.projectId ?? null,
    inputs: typeof row.inputs === "string" ? JSON.parse(row.inputs) : row.inputs,
    outputs: typeof row.outputs === "string" ? JSON.parse(row.outputs) : row.outputs,
  });
}

export function createCalculatorsRepo(db: Db) {
  return {
    list(): Calculator[] {
      return db.select().from(calculators).all().map(rowToCalculator);
    },

    get(id: string): Calculator | undefined {
      const row = db.select().from(calculators).where(eq(calculators.id, id)).get();
      return row ? rowToCalculator(row) : undefined;
    },

    create(input: Calculator): Calculator {
      const parsed = Calculator.parse(input);
      const now = new Date().toISOString();
      const row: typeof calculators.$inferInsert = {
        id: nanoid(),
        name: parsed.name,
        description: parsed.description,
        inputs: parsed.inputs,
        formula: parsed.formula,
        outputs: parsed.outputs,
        citation: parsed.citation ?? null,
        builtin: parsed.builtin,
        createdAt: now,
        updatedAt: now,
      };
      db.insert(calculators).values(row).run();
      return rowToCalculator(row as typeof calculators.$inferSelect);
    },

    update(id: string, input: Partial<Calculator>): Calculator | undefined {
      const existing = db.select().from(calculators).where(eq(calculators.id, id)).get();
      if (!existing) return undefined;

      const patch: Partial<typeof calculators.$inferInsert> = {
        updatedAt: new Date().toISOString(),
      };
      if (input.name !== undefined) patch.name = input.name;
      if (input.description !== undefined) patch.description = input.description;
      if (input.inputs !== undefined) patch.inputs = input.inputs;
      if (input.formula !== undefined) patch.formula = input.formula;
      if (input.outputs !== undefined) patch.outputs = input.outputs;
      if (input.citation !== undefined) patch.citation = input.citation ?? null;

      db.update(calculators).set(patch).where(eq(calculators.id, id)).run();
      const row = db.select().from(calculators).where(eq(calculators.id, id)).get();
      return row ? rowToCalculator(row) : undefined;
    },

    delete(id: string): void {
      db.delete(calculators).where(eq(calculators.id, id)).run();
    },

    /**
     * Insert a shipped calculator if it isn't already present.
     *
     * Deliberately insert-only: seeds are the app's starting knowledge, but
     * once a row exists it belongs to the user. Upserting on every boot would
     * silently revert their edits, which breaks the whole "the library is
     * yours, and it's data" premise. Returns true when a row was created.
     */
    seed(calc: Calculator): boolean {
      const existing = db
        .select()
        .from(calculators)
        .where(eq(calculators.id, calc.id))
        .get();
      if (existing) return false;
      db.insert(calculators)
        .values({
          id: calc.id,
          name: calc.name,
          description: calc.description,
          inputs: calc.inputs,
          formula: calc.formula,
          outputs: calc.outputs,
          citation: calc.citation ?? null,
          builtin: calc.builtin,
          createdAt: calc.createdAt,
          updatedAt: calc.updatedAt,
        })
        .run();
      return true;
    },
  };
}

export function createCalculatorRunsRepo(db: Db) {
  return {
    create(input: CalculatorRun): CalculatorRun {
      const parsed = CalculatorRun.parse(input);
      const row: typeof calculatorRuns.$inferInsert = {
        id: nanoid(),
        calculatorId: parsed.calculatorId,
        projectId: parsed.projectId,
        inputs: parsed.inputs,
        outputs: parsed.outputs,
        createdAt: new Date().toISOString(),
      };
      db.insert(calculatorRuns).values(row).run();
      return rowToCalculatorRun(row as typeof calculatorRuns.$inferSelect);
    },

    get(id: string): CalculatorRun | undefined {
      const row = db.select().from(calculatorRuns).where(eq(calculatorRuns.id, id)).get();
      return row ? rowToCalculatorRun(row) : undefined;
    },

    listByProject(projectId: string): CalculatorRun[] {
      return db
        .select()
        .from(calculatorRuns)
        .where(eq(calculatorRuns.projectId, projectId))
        .all()
        .map(rowToCalculatorRun);
    },
  };
}
