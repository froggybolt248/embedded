import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";

const dataDir = mkdtempSync(join(tmpdir(), "embedded-ds-upload-test-"));
process.env["EMBEDDED_DATA_DIR"] = dataDir;

const { buildApp } = await import("./app.js");

// Uploading a datasheet grounds the part, and a thin read escalates to the
// vision tier whenever a provider answers (see deepen.ts `healthyProvider`).
// This suite is about the upload route, not about extraction quality, so it
// pins the provider at a port nothing listens on: the escalation is then
// skipped for a stated reason rather than because of whatever happens to be
// installed on the machine running the tests.
const { writeLlmSettings } = await import("./services/llm-settings.js");
const { defaultLlmSettings } = await import("@embedded/llm");
const base = defaultLlmSettings();
writeLlmSettings({ ...base, ollama: { ...base.ollama, baseUrl: "http://127.0.0.1:1" } });

/**
 * A structurally valid PDF with a text layer and no spec tables. Enough for
 * pdfjs to open and read, which is the point: it proves the request reaches the
 * real extractor rather than being turned away at the door.
 */
function minimalPdf(): Buffer {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
    "<< /Length 46 >>\nstream\nBT /F1 12 Tf 72 700 Td (Marketing blurb) Tj ET\nendstream",
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

/** multipart/form-data body, built by hand so the test posts what a browser posts */
function multipartBody(filename: string, bytes: Buffer): { body: Buffer; contentType: string } {
  const boundary = "----embeddedtestboundary";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: application/pdf\r\n\r\n`,
    "latin1",
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "latin1");
  return {
    body: Buffer.concat([head, bytes, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

describe("POST /components/:id/datasheet", () => {
  let app: FastifyInstance;
  let componentId: string;

  beforeAll(async () => {
    app = buildApp();
    await app.ready();
    const created = await app.inject({
      method: "POST",
      url: "/api/components",
      payload: { mpn: "NRF52840", category: "mcu" },
    });
    componentId = (created.json() as { id: string }).id;
  });

  afterAll(async () => {
    (app.db as unknown as { $client: { close(): void } }).$client.close();
    await app.close();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  async function upload(id: string, filename: string, bytes: Buffer) {
    const { body, contentType } = multipartBody(filename, bytes);
    return app.inject({
      method: "POST",
      url: `/api/components/${id}/datasheet`,
      payload: body,
      headers: { "content-type": contentType },
    });
  }

  it("reads a hand-supplied PDF through the real pipeline", async () => {
    // The route lives in a different plugin scope than /datasheets, which is
    // where @fastify/multipart used to be registered — so `req.file()` did not
    // exist here and every upload threw, while typecheck stayed green. Reaching
    // the extractor at all (rather than a 400 or a crash) is what this asserts;
    // 422 is the honest answer for a PDF with no spec tables in it.
    const res = await upload(componentId, "nrf52840_ps.pdf", minimalPdf());
    expect(res.statusCode).toBe(422);
    expect(res.json()).toMatchObject({ status: "unavailable" });
  });

  it("refuses a vendor's HTML page saved under a .pdf name", async () => {
    // Exactly how the nRF52840 failed in real use: the link answered with a
    // product page, not a datasheet. Trusting the filename would store the page
    // as the part's datasheet and ground the part against nothing.
    const html = Buffer.from("<!DOCTYPE html><html><body>Product page</body></html>", "latin1");
    const res = await upload(componentId, "nrf52840_ps.pdf", html);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: "that file is not a PDF" });
  });

  it("404s for a component that does not exist", async () => {
    const res = await upload("no-such-component", "x.pdf", minimalPdf());
    expect(res.statusCode).toBe(404);
  });
});
