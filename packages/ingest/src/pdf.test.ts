import { readFileSync, existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { LoadedPdf, decodeSymbolPua } from "./pdf.js";

describe("decodeSymbolPua", () => {
  it("decodes the Symbol-font mu that SX1262 prints for µA", () => {
    // U+F06D is Symbol position 0x6D, the real encoding on SX1262 p16
    expect(decodeSymbolPua("")).toBe("µ");
    expect(decodeSymbolPua("A")).toBe("µA");
  });

  it("decodes the other unit-bearing Symbol glyphs", () => {
    expect(decodeSymbolPua("")).toBe("Ω"); // ohm
    expect(decodeSymbolPua("C")).toBe("°C");
    expect(decodeSymbolPua("2")).toBe("±2");
    expect(decodeSymbolPua(" 5")).toBe("≤ 5");
  });

  it("leaves ordinary text untouched", () => {
    expect(decodeSymbolPua("1.2 mA")).toBe("1.2 mA");
    expect(decodeSymbolPua("µA")).toBe("µA");
    expect(decodeSymbolPua("")).toBe("");
  });

  it("leaves an unlisted PUA code alone rather than guessing", () => {
    // a non-Symbol font's private glyph has no known meaning; inventing one
    // would be exactly the confidently-wrong reading this tier exists to avoid
    expect(decodeSymbolPua("")).toBe("");
    expect(decodeSymbolPua("")).toBe("");
  });
});

// Real-datasheet smoke test; skipped when the fixture isn't present.
const FIXTURE =
  process.env["BME280_PDF"] ??
  "C:/Users/Frogg/AppData/Local/Temp/claude/C--Users-Frogg-projects-embedded/f46e8160-1a8f-49a1-89a2-0ae4364cf15c/scratchpad/bme280.pdf";

describe.skipIf(!existsSync(FIXTURE))("LoadedPdf (BME280 datasheet)", () => {
  it("opens, counts pages, renders PNG, extracts text", async () => {
    const pdf = await LoadedPdf.open(new Uint8Array(readFileSync(FIXTURE)));
    expect(pdf.pageCount).toBeGreaterThan(30);

    const page = await pdf.renderPage(1);
    // PNG magic bytes
    expect(page.png.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    expect(page.width).toBeGreaterThan(500);

    const text = await pdf.pageText(1);
    expect(text).toMatch(/BME280/i);

    await pdf.close();
  }, 60_000);
});
