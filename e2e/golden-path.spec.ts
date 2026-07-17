import { test, expect } from "@playwright/test";

/**
 * Golden path: Projects -> create from an archetype -> confirm its suggested
 * blocks appear -> bind a part to a block -> confirm grounding resolves ->
 * confirm the power budget renders.
 *
 * The temp EMBEDDED_DATA_DIR (see playwright.config.ts) starts with
 * migrations + seeded archetypes but ZERO components — the 22k-part library
 * came from a KiCad import, not a migration. So step "bind a part" has
 * nothing to bind unless something seeds one first.
 *
 * Fixture choice: POST one component straight through the real API in
 * beforeAll, with `specs.powerStates` already populated and NO
 * `variantAttrs.datasheet`. Two reasons this beats the alternatives:
 *  - It's the real persistence path (same route the app itself uses), unlike
 *    reaching into the DB directly — so the fixture is exercised, not faked.
 *  - Per apps/server/src/services/deepen.ts, `isGrounded()` is true the
 *    moment powerStates is non-empty, and `deepenComponent` short-circuits to
 *    "grounded" for an already-grounded part BEFORE it would ever fetch a
 *    URL. With no datasheet URL on the fixture there is nothing to fetch
 *    even on that path. So binding this part triggers the real
 *    bind -> deepenInBackground -> grounding flow, but it resolves
 *    synchronously with zero network calls — fast and hermetic, and it still
 *    genuinely exercises the grounding indicator rather than special-casing
 *    it away.
 */

const FIXTURE_MPN = "E2E-TEST-SENSOR-001";

test.beforeAll(async ({ playwright, baseURL }) => {
  const ctx = await playwright.request.newContext({ baseURL });
  const res = await ctx.post("/api/components", {
    data: {
      mpn: FIXTURE_MPN,
      manufacturer: "Fixture Co",
      description: "E2E fixture — pre-grounded, no datasheet URL, no network fetch",
      category: "sensor",
      specs: {
        powerStates: [
          {
            name: "active measurement",
            mode: "active",
            current: {
              typ: { value: 0.5, unit: "mA", source: { kind: "manual", verifiedBy: "human" } },
            },
          },
          {
            name: "sleep",
            mode: "sleep",
            current: {
              typ: { value: 0.001, unit: "mA", source: { kind: "manual", verifiedBy: "human" } },
            },
          },
        ],
      },
    },
  });
  expect(res.ok(), `fixture component POST failed: ${res.status()} ${await res.text()}`).toBeTruthy();
  await ctx.dispose();
});

test("create a project from an archetype, bind a part, see it grounded, see a power budget", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Projects" })).toBeVisible();

  // Start from the coin-cell-sensor archetype (seeds/archetypes.json).
  await page.getByRole("button", { name: /Coin-cell environment sensor/ }).click();
  await page.getByPlaceholder(/My coin-cell environment sensor/i).fill("E2E Coin Cell Sensor");
  await page.getByRole("button", { name: "Start", exact: true }).click();

  // Lands on the new project's detail page.
  await expect(page).toHaveURL(/\/projects\/[^/]+$/);
  await expect(page.getByRole("heading", { name: "E2E Coin Cell Sensor" })).toBeVisible();

  // The archetype's suggested blocks were seeded onto the project. Scoped to
  // the Architecture section: the same block name (e.g. "MCU") also appears
  // in the Power budget panel's "Not in this estimate" list once blocks are
  // unbound, which would otherwise make these locators ambiguous.
  const architecture = page.locator("section", {
    has: page.getByRole("heading", { name: "Architecture" }),
  });
  await expect(architecture.getByText("MCU", { exact: true })).toBeVisible();
  await expect(architecture.getByText("Environment sensor", { exact: true })).toBeVisible();
  await expect(architecture.getByText("Regulator", { exact: true })).toBeVisible();

  // Bind the fixture component to the "Environment sensor" block.
  const sensorRow = architecture.locator("li").filter({ hasText: "Environment sensor" });
  await sensorRow.getByRole("button", { name: "bind a part" }).click();
  await sensorRow.getByPlaceholder(/Search parts/i).fill("E2E-TEST-SENSOR");
  await expect(sensorRow.getByText(FIXTURE_MPN)).toBeVisible({ timeout: 10_000 });
  await sensorRow.getByText(FIXTURE_MPN).click();

  // The picker closes and the block now shows the bound part by MPN.
  await expect(sensorRow.getByRole("link", { name: FIXTURE_MPN })).toBeVisible();

  // Grounding resolves. The fixture has no datasheet URL and is already
  // grounded server-side, so this should settle fast — but the UI polls at
  // 800ms, so give it real room rather than asserting on the first tick.
  await expect(sensorRow.getByText("grounded", { exact: true })).toBeVisible({ timeout: 15_000 });

  // The power budget renders using the fixture's manually-sourced currents.
  const powerBudget = page.locator("section", {
    has: page.getByRole("heading", { name: "Power budget" }),
  });
  await expect(powerBudget).toBeVisible();
  await expect(powerBudget.getByText("estimated battery life")).toBeVisible();
  await expect(powerBudget.getByText("average draw")).toBeVisible();
  await expect(
    powerBudget.getByText(new RegExp(`Environment sensor.*${FIXTURE_MPN}`)),
  ).toBeVisible();
});
