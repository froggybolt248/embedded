import { afterAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LlmProvider, ExtractResult, ProviderHealth } from "@embedded/llm";

// EMBEDDED_DATA_DIR must be set before @embedded/db resolves the sqlite path,
// so this runs before importing the db package or the app — same seam as
// grounding-persistence.test.ts.
const dataDir = mkdtempSync(join(tmpdir(), "embedded-deepen-escalation-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

/**
 * `createLlmProvider` is the ONE seam deepen.ts uses to reach a real model
 * (see routes/llm.ts — same resolution). Stubbing it here means these tests
 * never touch a real Ollama/Claude Code process: fast, deterministic, and
 * true regardless of what happens to be installed on the machine running them.
 */
const mockCreateLlmProvider = vi.fn();
vi.mock("@embedded/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@embedded/llm")>();
  return { ...actual, createLlmProvider: mockCreateLlmProvider };
});

const { createDb, migrateDb, createComponentsRepo, createDatasheetsRepo, createExtractionRunsRepo } =
  await import("@embedded/db");
const { groundFromBytes, groundingState } = await import("./deepen.js");
const { writeLlmSettings } = await import("./llm-settings.js");
const { defaultLlmSettings } = await import("@embedded/llm");

/**
 * A structurally valid PDF with a text layer and no spec tables — same fixture
 * shape as apps/server/src/component-datasheet.test.ts's `minimalPdf()`. The
 * deterministic tier finds nothing in it, which is exactly the "thin read"
 * this escalation exists to rescue: the ESP32 bug report was a real datasheet
 * whose power-pin table lived in a scanned image the free tier cannot read.
 */
function minimalPdf(text = "Marketing blurb"): Buffer {
  const stream = `BT /F1 12 Tf 72 700 Td (${text}) Tj ET`;
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** A fake provider whose vision "extraction" hands back one real power-state row. */
function fakeVisionProvider(): LlmProvider {
  const health: ProviderHealth = { ok: true, detail: "fake provider always healthy" };
  return {
    kind: "ollama",
    modelFor: (tier) => (tier === "extraction" ? "fake-vision-model" : "fake-model"),
    capabilities: () => ({ vision: true, structuredOutput: "native" }),
    health: async () => health,
    preflight: async () => {},
    extract: async <T,>(_tier: string, req: { schemaName: string }): Promise<ExtractResult<T>> => {
      if (req.schemaName === "datasheet-triage") {
        return { data: { pages: [] } as T, model: "fake-model", raw: "{}", retried: false };
      }
      // section extraction: the vision-only rescue for the image-only table.
      const data = {
        powerStates: [
          {
            name: "active",
            currentTyp: 12,
            currentMax: 18,
            unit: "mA",
            page: 1,
            snippet: "Marketing blurb",
          },
        ],
      };
      return { data: data as T, model: "fake-vision-model", raw: "{}", retried: false };
    },
    // eslint-disable-next-line @typescript-eslint/require-yield
    stream: async function* () {
      throw new Error("not used by extraction");
    },
  };
}

/**
 * A configured provider with nothing behind it — the shape of a default
 * install whose Ollama is not running. `health()` reports the failure rather
 * than throwing, which is what a real provider does.
 */
function unreachableProvider(): LlmProvider {
  return {
    ...fakeVisionProvider(),
    health: async () => ({ ok: false, detail: "connection refused" }),
    extract: async () => {
      throw new Error("unreachable provider must never be asked to extract");
    },
  };
}

const dbFile = join(dataDir, "deepen-test.db");
const db = createDb(dbFile);
migrateDb(db);
const componentsRepo = createComponentsRepo(db);
const dsRepo = createDatasheetsRepo(db);
const runsRepo = createExtractionRunsRepo(db);

afterAll(() => {
  (db as unknown as { $client: { close(): void } }).$client.close();
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("deepenComponent escalation to hybrid extraction", () => {
  it("escalates to the vision tier when the deterministic read is thin AND a provider is configured and healthy", async () => {
    writeLlmSettings(defaultLlmSettings());
    mockCreateLlmProvider.mockClear();
    mockCreateLlmProvider.mockReturnValue(fakeVisionProvider());

    const component = componentsRepo.create({ mpn: "ESCALATE-GROUNDED", category: "mcu" });
    const result = await groundFromBytes(db, component, minimalPdf());

    expect(result.status).toBe("grounded");

    const grounded = componentsRepo.get(component.id);
    expect(grounded?.specs.powerStates).toHaveLength(1);
    expect(grounded?.specs.powerStates[0]?.name).toBe("active");

    // Governing rule: a vision-tier row is machine-read, never human-verified —
    // only a human clicking "accept" in review earns that stamp.
    const source = grounded?.specs.powerStates[0]?.current.typ?.source;
    expect(source?.verifiedBy).toBeUndefined();

    // Visible in the UI: the final detail says which tier actually grounded it.
    const state = groundingState(db, component.id);
    expect(state?.status).toBe("grounded");
    expect(state?.detail).toMatch(/vision-assisted/);

    // Both attempts are recorded: the free deterministic run and the escalated one.
    const datasheet = dsRepo.findByComponent(component.id);
    expect(datasheet).toBeDefined();
    const runs = runsRepo.listByDatasheet(datasheet!.id);
    expect(runs.some((r) => r.model.startsWith("deterministic"))).toBe(true);
    expect(runs.some((r) => r.model === "fake-vision-model")).toBe(true);

    expect(mockCreateLlmProvider).toHaveBeenCalled();
  });

  it("keeps today's honest `unavailable` outcome when no provider answers", async () => {
    // The real no-escalation case: a provider is configured (it always is —
    // `activeProvider` defaults to ollama) but nothing is actually running to
    // answer it. That, not a settings flag, is what must hold escalation back.
    writeLlmSettings(defaultLlmSettings());
    mockCreateLlmProvider.mockClear();
    mockCreateLlmProvider.mockReturnValue(unreachableProvider());

    const component = componentsRepo.create({ mpn: "NO-PROVIDER-CONFIGURED", category: "mcu" });
    const result = await groundFromBytes(db, component, minimalPdf("Different marketing blurb"));

    expect(result.status).toBe("unavailable");
    expect(result.reason).toBe("no extractable tables");

    const state = groundingState(db, component.id);
    expect(state?.status).toBe("unavailable");
    expect(state?.detail).not.toMatch(/vision/);

    // The provider WAS consulted — that is the point — but it failed its
    // health check, so no extraction was ever attempted against it.
    expect(mockCreateLlmProvider).toHaveBeenCalled();

    // Only the free deterministic run exists — no second, hybrid run row.
    const datasheet = dsRepo.findByComponent(component.id);
    expect(datasheet).toBeDefined();
    const runs = runsRepo.listByDatasheet(datasheet!.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.model.startsWith("deterministic")).toBe(true);
  });
});
