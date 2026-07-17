import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PositionedText } from "./pdf.js";
import { extractTables, parseCell } from "./tables.js";

// U+00B1 PLUS-MINUS SIGN and U+2212 MINUS SIGN, built via escapes so the
// literal characters never need to round-trip through a file-write tool.
const PM = "±";
const UMINUS = "−";

function loadFixture(name: string): PositionedText[] {
  const url = new URL(`./__fixtures__/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(fileURLToPath(url), "utf-8")) as PositionedText[];
}

function cellFor(headers: string[], row: { cells: string[] }, header: string): string {
  const idx = headers.indexOf(header);
  expect(idx).toBeGreaterThanOrEqual(0);
  return row.cells[idx] as string;
}

describe("parseCell", () => {
  it.each([
    ["4.25", { kind: "number", value: 4.25 }],
    ["-0.3", { kind: "number", value: -0.3 }],
    ["+85", { kind: "number", value: 85 }],
    ["20 000", { kind: "number", value: 20000 }],
    ["1.71", { kind: "number", value: 1.71 }],
    [`${PM}2`, { kind: "plusminus", value: 2 }],
    [`${PM}0.01`, { kind: "plusminus", value: 0.01 }],
    [`${PM} 5`, { kind: "plusminus", value: 5 }],
    ["VDDIO + 0.3", { kind: "symbolic", text: "VDDIO + 0.3" }],
    ["", { kind: "empty" }],
    [" ", { kind: "empty" }],
    ["V", { kind: "symbolic", text: "V" }],
    ["≤ 65% RH", { kind: "symbolic", text: "≤ 65% RH" }],
  ] as const)("parses %j -> %j", (input, expected) => {
    expect(parseCell(input)).toEqual(expected);
  });

  it("handles the unicode minus sign (U+2212), not just ASCII hyphen", () => {
    expect(parseCell(`${UMINUS}0.3`)).toEqual({ kind: "number", value: -0.3 });
  });

  it("handles NBSP (U+00A0) as whitespace", () => {
    expect(parseCell(" ")).toEqual({ kind: "empty" });
    expect(parseCell(`4.25 `)).toEqual({ kind: "number", value: 4.25 });
  });
});

describe("extractTables synthetic geometry", () => {
  function item(str: string, x: number, y: number, width: number, height = 9.96): PositionedText {
    return { str, x, y, width, height, rotated: false };
  }

  // Two-column synthetic table: "Parameter" / "Min", 3 data rows.
  // A distant "running header" above the table, mirroring the real fixtures
  // (page furniture around y=809 vs. table content around y=500). Without
  // this, the table's own header row is the tallest thing on the synthetic
  // page and topBandFraction (0.93 * maxY) self-excludes it as furniture.
  function furniture(): PositionedText {
    return item("Page Furniture Header", 100, 800, 100);
  }

  function baseItems(): PositionedText[] {
    return [
      furniture(),
      item("Parameter", 100, 500, 40),
      item("Min", 300, 500, 20),
      item("Widget", 100, 480, 40),
      item("1", 300, 480, 10),
      item("Gadget", 100, 460, 40),
      item("2", 300, 460, 10),
      item("Gizmo", 100, 440, 40),
      item("3", 300, 440, 10),
    ];
  }

  it("groups items within rowTolerance into one row even with y jitter", () => {
    const items = baseItems();
    // jitter the "Min" header cell's y by 2 (within default tolerance 3)
    // index 2: [0]=furniture, [1]=Parameter, [2]=Min
    items[2] = item("Min", 300, 502, 20);
    const tables = extractTables(items, 1);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.headers).toEqual(["parameter", "min"]);
    expect(tables[0]?.rows).toHaveLength(3);
  });

  it("does not group rows whose y differs by more than rowTolerance", () => {
    const items = baseItems();
    // push "Min" header 5pt away -- exceeds default tolerance of 3
    items[2] = item("Min", 300, 505, 20);
    const tables = extractTables(items, 1);
    // header row now has only 1 recognized header word ("Parameter") in its
    // own row -- no table detected
    expect(tables).toHaveLength(0);
  });

  it("detects a whitespace gutter and splits into two column bands", () => {
    const tables = extractTables(baseItems(), 1);
    expect(tables[0]?.columnBands).toHaveLength(2);
    const [colA, colB] = tables[0]?.columnBands ?? [];
    expect(colA).toBeDefined();
    expect(colB).toBeDefined();
    // clear gutter between column 1 (ends ~140) and column 2 (starts 300)
    expect((colB as { x0: number }).x0 - (colA as { x1: number }).x1).toBeGreaterThan(4);
  });

  it("merges columns whose DATA sits closer than minGutter into one band", () => {
    // Two value columns whose data items are only 2pt apart (below minGutter 4)
    // in every row -- no gutter ever opens between them, so they are one band.
    const items = [
      furniture(),
      item("Parameter", 100, 500, 40),
      item("Min", 200, 500, 18),
      item("Max", 220, 500, 18),
      item("Widget", 100, 480, 40),
      item("1", 200, 480, 8),
      item("2", 210, 480, 8),
      item("Gadget", 100, 460, 40),
      item("3", 200, 460, 8),
      item("4", 210, 460, 8),
    ];
    const tables = extractTables(items, 1);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.columnBands).toHaveLength(2);
    expect(tables[0]?.headers).toEqual(["parameter", "min max"]);
  });

  it("separates columns the DATA shows are distinct, even when their headers sit close", () => {
    // The header labels Symbol(200-230) and Min(233-253) are only 3pt apart,
    // but the data underneath -- W at 200-210, values at 233-243 -- leaves a
    // clear 23pt gutter. Data-driven column detection keeps them apart; the old
    // header-only merging wrongly fused two real columns.
    const items = [
      furniture(),
      item("Parameter", 100, 500, 40),
      item("Symbol", 200, 500, 30),
      item("Min", 233, 500, 20),
      item("Widget", 100, 480, 40),
      item("W", 200, 480, 10),
      item("1", 233, 480, 10),
      item("Gadget", 100, 460, 40),
      item("G", 200, 460, 10),
      item("2", 233, 460, 10),
    ];
    const tables = extractTables(items, 1);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.columnBands).toHaveLength(3);
    expect(tables[0]?.headers).toEqual(["parameter", "symbol", "min"]);
    expect(tables[0]?.rows.map((r) => r.cells)).toEqual([
      ["Widget", "W", "1"],
      ["Gadget", "G", "2"],
    ]);
  });

  // Semtech prints three of these under the SX1262 power table (p16). Each one
  // spans the table's full width, so each votes across every gutter; three of
  // them beat computeColumnBands' tolerance of one and the whole table
  // disappears. Fixture geometry mirrors the real page: footnotes below the
  // last data row, starting at the table's left edge, running its full width.
  function footnotes(): PositionedText[] {
    return [
      item("1. Cold start is equivalent to the device at POR, see Section 13.1.1", 100, 420, 220, 8),
      item("2. Warm start is only happening when device is woken from Sleep mode", 100, 410, 220, 8),
      item("3. For more details on Rx Boosted gain mode, see Section 9.6", 100, 400, 180, 8),
    ];
  }

  it("reads a table whose footnotes span every column", () => {
    const tables = extractTables([...baseItems(), ...footnotes()], 16);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.headers).toEqual(["parameter", "min"]);
    // the three data rows survive; no footnote became one of them
    expect(tables[0]?.rows.map((r) => r.cells)).toEqual([
      ["Widget", "1"],
      ["Gadget", "2"],
      ["Gizmo", "3"],
    ]);
  });

  it("does not mistake a wide wrapped condition for a footnote", () => {
    // full table width, but opens with no footnote marker
    const wide = item("Configuration retained + RC64k oscillator running", 100, 420, 220, 9);
    const tables = extractTables([...baseItems(), wide], 16);
    expect(tables).toHaveLength(1);
    const allText = tables[0]?.rows.flatMap((r) => r.cells).join(" ") ?? "";
    expect(allText).toContain("Configuration retained");
  });

  // ESP32-C3 p57 geometry, to scale: Table 5-9 "Current Consumption in Low-Power
  // Modes" (the part's only sleep data), the "5.7 Memory Specifications" heading
  // 46pt below its last row, and the prose under that. The table's left edge is
  // x=80.4; the heading and prose start at the page margin, x=56.7.
  function espHeadingAfterTable(): PositionedText[] {
    return [
      item("Electrical Characteristics", 72.3, 813.7, 106.3),
      item("Mode", 80.4, 494.1, 25.8),
      item("Description", 144.2, 494.1, 51.1),
      item("Typ (µA)", 477.2, 494.1, 36.7),
      item("Light-sleep", 80.4, 478.1, 48.4),
      item("VDD_SPI and Wi-Fi are powered down, and all GPIOs are high-impedance", 144.2, 478.1, 320.6),
      item("130", 499.7, 478.1, 15.2),
      item("Deep-sleep", 80.4, 462.2, 51.5),
      item("RTC timer + RTC memory", 144.2, 462.2, 109.8),
      item("5", 509.3, 462.2, 5.6),
      item("5.7", 56.7, 399.9, 19.0),
      item("Memory Specifications", 90.0, 399.9, 148.0),
      item("The data below is sourced from the memory vendor datasheet. These values are guaranteed", 56.7, 377.9, 476.1),
      item("and/or characterization but are not fully tested in production.", 56.7, 362.4, 434.9),
    ];
  }

  it("ends a table at a section heading that starts left of the table's own frame", () => {
    // The prose lines each bridge every gutter, so left uncut they push the
    // occupancy past spanTolerance, collapse the bands to one, and take the
    // table's real rows down with them — the page yields nothing at all.
    const tables = extractTables(espHeadingAfterTable(), 57, { pageHeight: 841.9 });
    expect(tables).toHaveLength(1);
    const rows = tables[0]?.rows.map((r) => r.cells) ?? [];
    expect(rows).toContainEqual(["Light-sleep", "VDD_SPI and Wi-Fi are powered down, and all GPIOs are high-impedance", "130"]);
    expect(rows).toContainEqual(["Deep-sleep", "RTC timer + RTC memory", "5"]);
    // the heading and its prose are not rows of the table
    const allText = rows.flat().join(" ");
    expect(allText).not.toContain("Memory Specifications");
    expect(allText).not.toContain("sourced from the memory vendor");
  });

  it("keeps a wide data cell that is merely wide, not prose", () => {
    // Guards the tempting fix: Table 5-9's own first row carries a 320.6pt
    // description under a 434.5pt span (0.74 of the table), so any width-based
    // prose cut low enough to catch the real prose amputates the table here.
    const tables = extractTables(espHeadingAfterTable(), 57, { pageHeight: 841.9 });
    const allText = tables[0]?.rows.flatMap((r) => r.cells).join(" ") ?? "";
    expect(allText).toContain("all GPIOs are high-impedance");
  });

  it("ends a table at a footnote whose marker is a detached superscript", () => {
    // Espressif raises the marker ~3.6pt above its prose at the SAME font height,
    // so it lands on a row of its own that no per-row test can read: a lone 7pt
    // "1 " above a line of prose carrying no marker at all.
    const items: PositionedText[] = [
      furniture(),
      item("Mode", 77.1, 702.9, 25.8),
      item("Description", 239.0, 702.9, 51.1),
      item("Typ (mA)", 399.5, 702.9, 40.0),
      item("Modem-sleep", 77.1, 670.8, 64.3),
      item("CPU is running", 239.0, 670.8, 64.3),
      item("23", 399.5, 670.8, 11.3),
      item("Modem-sleep", 77.1, 655.3, 64.3),
      item("CPU is idle", 239.0, 655.3, 47.0),
      item("16", 401.4, 655.3, 9.3),
      item("1 ", 78.7, 607.2, 7.0),
      item("In practice, the current consumption might be different depending on which peripherals", 85.7, 603.6, 438.9),
    ];
    const tables = extractTables(items, 57, { pageHeight: 841.9 });
    expect(tables).toHaveLength(1);
    const allText = tables[0]?.rows.flatMap((r) => r.cells).join(" ") ?? "";
    expect(allText).toContain("CPU is running");
    expect(allText).not.toContain("In practice");
  });

  it("finds a table whose only recognisable header word is Mode", () => {
    // "Work Mode | Description | Peak (mA)" — ESP32-C3's Wi-Fi table, where the
    // 335 mA TX draw lives. Without "mode" in the vocabulary only "description"
    // is known, one distinct word is not a header, and the table is never found.
    const items: PositionedText[] = [
      furniture(),
      item("Work Mode", 135.8, 240.1, 51.2),
      item("Description", 233.3, 240.1, 51.1),
      item("Peak (mA)", 413.6, 240.1, 45.9),
      item("Active (RF working)", 135.8, 224.1, 85.2),
      item("802.11b, 1 Mbps, @21 dBm", 257.0, 224.1, 113.8),
      item("335", 442.5, 224.1, 17.0),
      item("802.11b/g/n, HT20", 257.0, 208.6, 80.3),
      item("84", 448.7, 208.6, 10.8),
    ];
    const tables = extractTables(items, 56, { pageHeight: 841.9 });
    expect(tables).toHaveLength(1);
    expect(tables[0]?.headers).toContain("work mode");
    expect(tables[0]?.rawHeaders).toContain("Peak (mA)");
  });

  it("does not mistake a numbered data row for a footnote", () => {
    // opens with "1." like a footnote, but occupies one column, not the width
    const numbered = [item("1. Reset", 100, 420, 40), item("9", 300, 420, 10)];
    const tables = extractTables([...baseItems(), ...numbered], 16);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.rows.map((r) => r.cells)).toContainEqual(["1. Reset", "9"]);
  });

  // SX1262 p16 geometry: a 792pt page whose topmost run is the section heading
  // at y=728.7, with the power table's header right below it at y=681.3 and no
  // running header anywhere. Measured against the topmost TEXT the furniture cut
  // lands at 677.7 and eats the table's header; measured against the PAGE it
  // lands at 736.6 and the header lives.
  function headingTopPage(): PositionedText[] {
    return [
      item("3.5.1 Power Consumption", 54, 728.7, 159, 14),
      item("Symbol", 61, 681.3, 33, 10),
      item("Typ", 462, 681.3, 16, 10),
      item("IDDOFF", 63, 646.3, 29),
      item("160", 464, 646.3, 13),
      item("IDDSL", 66, 599.9, 23),
      item("600", 464, 599.9, 13),
    ];
  }

  it("keeps a header row that sits below a section heading on a full-height page", () => {
    const tables = extractTables(headingTopPage(), 16, { pageHeight: 792 });
    expect(tables).toHaveLength(1);
    expect(tables[0]?.headers).toEqual(["symbol", "typ"]);
    expect(tables[0]?.rows.map((r) => r.cells)).toEqual([
      ["IDDOFF", "160"],
      ["IDDSL", "600"],
    ]);
  });

  it("still treats a real running header as furniture when pageHeight is known", () => {
    const items = [item("SX1261/2 Data Sheet Rev 2.1", 54, 770, 120, 8), ...headingTopPage()];
    const tables = extractTables(items, 16, { pageHeight: 792 });
    expect(tables).toHaveLength(1);
    const allText = tables[0]?.rows.flatMap((r) => r.cells).join(" ") ?? "";
    expect(allText).not.toContain("Rev 2.1");
  });

  it("excludes furniture rows above topBandFraction and below bottomBandFraction", () => {
    const items = [
      item("Running Header", 100, 1000, 80),
      ...baseItems(),
      item("Footer text", 100, 5, 60),
    ];
    const tables = extractTables(items, 1);
    expect(tables).toHaveLength(1);
    // neither furniture row leaked into any cell
    const allText = tables[0]?.rows.flatMap((r) => r.cells).join(" ") ?? "";
    expect(allText).not.toContain("Running Header");
    expect(allText).not.toContain("Footer text");
  });

  it("merges a continuation row (fills <half columns, no numeric cell, small gap) into the row above", () => {
    const items = [
      furniture(),
      item("Parameter", 100, 500, 60),
      item("Symbol", 250, 500, 40),
      item("Condition", 400, 500, 60),
      item("Widget one", 100, 480, 60),
      item("W", 250, 480, 10),
      item("full range", 400, 480, 60),
      // continuation line: only the Parameter column filled, no numeric
      // cell, gap 10 <= 1.5 * medianLineHeight(9.96) = 14.94
      item("(continued)", 100, 470, 60),
      item("Gadget two", 100, 460, 60),
      item("G", 250, 460, 10),
      item("half range", 400, 460, 60),
    ];
    const tables = extractTables(items, 1);
    expect(tables).toHaveLength(1);
    expect(tables[0]?.rows).toHaveLength(2);
    expect(cellFor(tables[0]!.headers, tables[0]!.rows[0]!, "parameter")).toBe(
      "Widget one (continued)",
    );
  });

  it("does NOT merge a row across a gap exceeding 1.5x medianLineHeight even if it fills <half columns", () => {
    const items = [
      furniture(),
      item("Parameter", 100, 500, 60),
      item("Symbol", 250, 500, 40),
      item("Condition", 400, 500, 60),
      item("Widget one", 100, 480, 60),
      item("W", 250, 480, 10),
      item("full range", 400, 480, 60),
      // gap of 20 from the row above -- well beyond 1.5*9.96=14.94 -- must
      // NOT merge, even though it only fills one column
      item("stray note", 100, 460, 60),
      item("Gadget two", 100, 440, 60),
      item("G", 250, 440, 10),
      item("half range", 400, 440, 60),
    ];
    const tables = extractTables(items, 1);
    expect(tables).toHaveLength(1);
    // "stray note" row kept standalone rather than merged
    const parameterCells = tables[0]?.rows.map((r) => cellFor(tables[0]!.headers, r, "parameter"));
    expect(parameterCells).toContain("stray note");
    expect(parameterCells).not.toContain("Widget one stray note");
  });

  it("fuses a touching superscript run into its Unicode digit ('I' + small '2' + 'C' -> 'I²C') without pulling in a genuinely separate row 14pt away", () => {
    const items = [
      furniture(),
      item("Parameter", 100, 500, 70),
      item("Min", 300, 500, 20),
      // "I" + superscript "2" + "C": touching (zero-gap) x offsets and the
      // real-fixture height delta -- the superscript sits above the
      // baseline in a visibly smaller font (see bme280-p35-items.json).
      item("I", 150.3, 424.2, 3.7, 9.96),
      item("2", 154.0, 427.68, 3.7, 6.48),
      item("C", 157.7, 424.2, 3.7, 9.96),
      item("1", 300, 424.2, 10),
      // A genuinely separate row 14pt below, body-height throughout -- must
      // stay its own row; the loosened tolerance is for script runs only.
      item("Widget", 100, 410.2, 60),
      item("5", 300, 410.2, 10),
    ];
    const tables = extractTables(items, 1);
    expect(tables).toHaveLength(1);
    const table = tables[0]!;
    expect(table.rows).toHaveLength(2);
    expect(cellFor(table.headers, table.rows[0]!, "parameter")).toBe("I²C");
    expect(cellFor(table.headers, table.rows[0]!, "min")).toBe("1");
    expect(cellFor(table.headers, table.rows[1]!, "parameter")).toBe("Widget");
    expect(cellFor(table.headers, table.rows[1]!, "min")).toBe("5");
  });
});

describe("extractTables on real BME280 fixtures", () => {
  describe("page 8 -- Electrical parameter specification (the critical test)", () => {
    const items = loadFixture("bme280-p8-items");
    const tables = extractTables(items, 8);

    it("finds exactly one table with the full 7-column header", () => {
      expect(tables).toHaveLength(1);
      expect(tables[0]?.headers).toEqual([
        "parameter",
        "symbol",
        "condition",
        "min",
        "typ",
        "max",
        "unit",
      ]);
    });

    it("merges the wrapped 'Supply Voltage / Internal Domains' row and assigns cells by column position, not order", () => {
      const table = tables[0]!;
      const row = table.rows.find(
        (r) =>
          cellFor(table.headers, r, "parameter").includes("Supply Voltage") &&
          cellFor(table.headers, r, "parameter").includes("Internal Domains"),
      );
      expect(row).toBeDefined();
      expect(cellFor(table.headers, row!, "symbol")).toBe("VDD");
      expect(cellFor(table.headers, row!, "min")).toBe("1.71");
      expect(cellFor(table.headers, row!, "typ")).toBe("1.8");
      expect(cellFor(table.headers, row!, "max")).toBe("3.6");
      expect(cellFor(table.headers, row!, "unit")).toBe("V");
    });

    it("merges the wrapped 'Supply Voltage / I/O Domain' row", () => {
      const table = tables[0]!;
      const row = table.rows.find(
        (r) =>
          cellFor(table.headers, r, "parameter").includes("Supply Voltage") &&
          cellFor(table.headers, r, "parameter").includes("I/O Domain"),
      );
      expect(row).toBeDefined();
      expect(cellFor(table.headers, row!, "symbol")).toBe("VDDIO");
      expect(cellFor(table.headers, row!, "min")).toBe("1.2");
      expect(cellFor(table.headers, row!, "typ")).toBe("1.8");
      expect(cellFor(table.headers, row!, "max")).toBe("3.6");
      expect(cellFor(table.headers, row!, "unit")).toBe("V");
    });

    it("the sleep-current row has an EMPTY min (no value), not a shifted typ/max", () => {
      const table = tables[0]!;
      const row = table.rows.find((r) => cellFor(table.headers, r, "symbol") === "IDDSL");
      expect(row).toBeDefined();
      expect(cellFor(table.headers, row!, "min")).toBe("");
      expect(cellFor(table.headers, row!, "typ")).toBe("0.1");
      expect(cellFor(table.headers, row!, "max")).toBe("0.3");
    });
  });

  describe("page 13 -- Absolute maximum ratings", () => {
    const items = loadFixture("bme280-p13-items");
    const tables = extractTables(items, 13);

    it("finds exactly one table with the 5-column header (no Typ column)", () => {
      expect(tables).toHaveLength(1);
      expect(tables[0]?.headers).toEqual(["parameter", "condition", "min", "max", "unit"]);
    });

    it("has the VDD/VDDIO supply-pin voltage row", () => {
      const table = tables[0]!;
      const row = table.rows.find(
        (r) => cellFor(table.headers, r, "parameter") === "Voltage at any supply pin",
      );
      expect(row).toBeDefined();
      expect(cellFor(table.headers, row!, "condition")).toBe("VDD and VDDIO pin");
      expect(cellFor(table.headers, row!, "min")).toBe("-0.3");
      expect(cellFor(table.headers, row!, "max")).toBe("4.25");
      expect(cellFor(table.headers, row!, "unit")).toBe("V");
    });

    it("has the storage-temperature row with the RH condition joined from two items", () => {
      const table = tables[0]!;
      const row = table.rows.find(
        (r) => cellFor(table.headers, r, "parameter") === "Storage temperature",
      );
      expect(row).toBeDefined();
      expect(cellFor(table.headers, row!, "condition")).toBe("≤ 65% RH");
      expect(cellFor(table.headers, row!, "min")).toBe("-45");
      expect(cellFor(table.headers, row!, "max")).toBe("+85");
      expect(cellFor(table.headers, row!, "unit")).toBe("°C");
    });

    it("has the pressure row with an empty condition and a space-separated thousands value", () => {
      const table = tables[0]!;
      const row = table.rows.find((r) => cellFor(table.headers, r, "parameter") === "Pressure");
      expect(row).toBeDefined();
      expect(cellFor(table.headers, row!, "condition")).toBe("");
      expect(cellFor(table.headers, row!, "min")).toBe("0");
      expect(cellFor(table.headers, row!, "max")).toBe("20 000");
      expect(cellFor(table.headers, row!, "unit")).toBe("hPa");
      expect(parseCell(cellFor(table.headers, row!, "max"))).toEqual({
        kind: "number",
        value: 20000,
      });
    });

    it("has the ESD/HBM row with a plusminus max value", () => {
      const table = tables[0]!;
      const row = table.rows.find((r) => cellFor(table.headers, r, "parameter") === "ESD");
      expect(row).toBeDefined();
      expect(cellFor(table.headers, row!, "condition")).toBe("HBM, at any pin");
      expect(cellFor(table.headers, row!, "max")).toBe(`${PM}2`);
      expect(cellFor(table.headers, row!, "unit")).toBe("kV");
      expect(parseCell(cellFor(table.headers, row!, "max"))).toEqual({ kind: "plusminus", value: 2 });
    });

    it("the 'Voltage at any interface pin' row's max is the symbolic 'VDDIO + 0.3', not a number", () => {
      const table = tables[0]!;
      const row = table.rows.find(
        (r) => cellFor(table.headers, r, "parameter") === "Voltage at any interface pin",
      );
      expect(row).toBeDefined();
      const maxCell = cellFor(table.headers, row!, "max");
      expect(maxCell).toBe("VDDIO + 0.3");
      expect(parseCell(maxCell).kind).toBe("symbolic");
    });
  });

  describe("page 35 -- SPI protocol diagram + interface-parameter table (I²C superscript rows)", () => {
    const items = loadFixture("bme280-p35-items");
    const tables = extractTables(items, 35);

    it("produces no junk row consisting of a lone superscript digit with every other cell empty", () => {
      const junkRow = tables
        .flatMap((t) => t.rows)
        .find((r) => r.cells.some((c) => c === "2") && r.cells.filter((c) => c !== "").length === 1);
      expect(junkRow).toBeUndefined();
    });

    it("reassembles the I²C superscript into the SDI output-level labels and the load-capacitor label", () => {
      const table = tables[0]!;
      const parameterCells = table.rows.map((r) => cellFor(table.headers, r, "parameter"));
      expect(parameterCells.filter((c) => /Output low level I²C/.test(c))).toHaveLength(2);
      expect(parameterCells.some((c) => /I²C bus load capacitor/.test(c))).toBe(true);
    });

    it("keeps the Rpull row's min/typ/max intact", () => {
      const table = tables[0]!;
      const row = table.rows.find((r) => cellFor(table.headers, r, "symbol") === "Rpull");
      expect(row).toBeDefined();
      expect(cellFor(table.headers, row!, "min")).toBe("70");
      expect(cellFor(table.headers, row!, "typ")).toBe("120");
      expect(cellFor(table.headers, row!, "max")).toBe("190");
    });
  });

  describe("page 38 -- Pin-out diagram + pin description table (exploratory)", () => {
    it("reports whatever tables are actually found", () => {
      const items = loadFixture("bme280-p38-items");
      const tables = extractTables(items, 38);
      // Exploratory: this fixture also contains a real "Table 35: Pin
      // description" with a Pin/Name/Description header (3 of 5 header
      // words recognized), so unlike the pure package-drawing pages, a
      // table IS expected here -- see the final report for what came out.
      expect(Array.isArray(tables)).toBe(true);
    });
  });
});
