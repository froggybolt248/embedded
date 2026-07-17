import { describe, expect, it } from "vitest";
import { extractDeterministic, mapTable } from "./deterministic.js";
import type { LoadedPdf, PositionedText } from "./pdf.js";
import type { ExtractedTable } from "./tables.js";

function table(headers: string[], rows: string[][], page = 13): ExtractedTable {
  return {
    page,
    headers: headers.map((h) => h.toLowerCase()),
    rawHeaders: headers,
    rows: rows.map((cells, i) => ({ y: 500 - i, cells })),
    columnBands: headers.map((_, i) => ({ x0: i * 60, x1: i * 60 + 50 })),
  };
}

describe("mapTable", () => {
  it("maps an absolute-max table to grounded, machine-attributed rated params", () => {
    const part = mapTable(
      table(
        ["Symbol", "Parameter", "Min", "Max", "Unit"],
        [
          ["VDD", "Supply voltage", "-0.3", "4.25", "V"],
          ["Tstg", "Storage temperature", "-45", "85", "°C"],
        ],
      ),
      "absolute-max",
    );
    expect(part.absoluteMax).toHaveLength(2);
    const vdd = part.absoluteMax![0]!;
    expect(vdd.param).toBe("vdd"); // resolved from the symbol column
    expect(vdd.min).toBe(-0.3);
    expect(vdd.max).toBe(4.25);
    expect(vdd.typ).toBeNull();
    expect(vdd.unit).toBe("V");
    expect(vdd.extractor).toBe("deterministic");
    expect(vdd.grounding).toBe("verified");
    expect(vdd.snippet).toContain("-0.3");
    expect(part.absoluteMax![1]!.param).toBe("tStorage");
  });

  it("drops a rated row that has no unit column value", () => {
    const part = mapTable(
      table(["Symbol", "Parameter", "Min", "Max"], [["VDD", "Supply voltage", "-0.3", "4.25"]]),
      "absolute-max",
    );
    expect(part.absoluteMax).toHaveLength(0);
  });

  it("reads a ± cell as a symmetric range", () => {
    const part = mapTable(
      table(["Parameter", "Max", "Unit"], [["Differential input", "±2", "V"]]),
      "recommended-operating",
    );
    const row = part.recommendedOperating![0]!;
    expect(row.min).toBe(-2);
    expect(row.max).toBe(2);
  });

  it("splits an electrical-characteristics table into power states and rated params by unit", () => {
    const part = mapTable(
      table(
        ["Symbol", "Parameter", "Typ", "Max", "Unit"],
        [
          ["IDDSL", "Sleep current", "0.1", "0.3", "µA"],
          ["VDD", "Supply voltage", "1.8", "3.6", "V"],
        ],
      ),
      "electrical-characteristics",
    );
    expect(part.powerStates).toHaveLength(1);
    expect(part.powerStates![0]!.name).toBe("Sleep current");
    expect(part.powerStates![0]!.mode).toBe("sleep");
    expect(part.powerStates![0]!.currentTyp).toBe(0.1);
    expect(part.powerStates![0]!.currentMax).toBe(0.3);
    expect(part.recommendedOperating).toHaveLength(1);
    expect(part.recommendedOperating![0]!.param).toBe("vdd");
  });

  it("keeps same-mode current rows distinct instead of collapsing them", () => {
    // The BME280 prints a different supply current per measurement type. All
    // of them bucket to mode `active`; naming them by mode loses every row but
    // the last, and with it the real worst-case draw.
    const part = mapTable(
      table(
        ["Parameter", "Condition", "Typ", "Unit"],
        [
          ["Supply current", "humidity measurement", "340", "µA"],
          ["Supply current", "pressure measurement", "714", "µA"],
          ["Supply current", "temperature measurement", "350", "µA"],
        ],
      ),
      "electrical-characteristics",
    );
    expect(part.powerStates).toHaveLength(3);
    expect(new Set(part.powerStates!.map((s) => s.name)).size).toBe(3);
    expect(part.powerStates!.every((s) => s.mode === "active")).toBe(true);
    expect(Math.max(...part.powerStates!.map((s) => s.currentTyp!))).toBe(714);
  });

  it("reads a current whose unit cell arrives with pdfjs's internal space", () => {
    // Verbatim from TPS63020 p6: pdfjs emits "μA" as two runs when the mu and
    // the A come from different fonts, so the cell is "μ A". Rejecting that on
    // the space dropped every µA row a regulator has — quiescent and shutdown,
    // the only two a sleep budget can use — and left `ISW Average switch current
    // limit` (unit "mA", one run) as the part's ONLY current row. That is how a
    // 4 A switch limit became a regulator's sleep draw.
    const part = mapTable(
      table(
        ["Parameter", "Test conditions", "Typ", "Max", "Unit"],
        [
          ["VIN and VINA Quiescent Iq", "IOUT = 0 mA", "25", "50", "μ A"],
          ["IS Shutdown current", "VEN = 0 V", "0.1", "1", "μ A"],
        ],
      ),
      "electrical-characteristics",
    );
    expect(part.powerStates).toHaveLength(2);
    expect(part.powerStates!.map((s) => s.unit)).toEqual(["µA", "µA"]); // stored as one token
    // a regulator's quiescent draw is continuous, and its shutdown row is the
    // only genuine sleep number it publishes
    expect(part.powerStates![0]!.mode).toBe("active");
    expect(part.powerStates![1]!.mode).toBe("sleep");
  });

  it("reads a current whose unit is stated only in the column header", () => {
    // ESP32-C3 p57 Table 5-9, verbatim shape: there is no Unit column anywhere on
    // the page — Espressif states the unit in the value column's own header. A
    // reader that requires a Unit cell finds none, rejects every row, and grounds
    // the part with no current data at all while the numbers sit right there.
    const part = mapTable(
      table(
        ["Mode", "Description", "Typ (µA)"],
        [
          ["Light-sleep", "VDD_SPI and Wi-Fi are powered down", "130"],
          ["Deep-sleep", "RTC timer + RTC memory", "5"],
        ],
        57,
      ),
      "electrical-characteristics",
    );
    expect(part.powerStates).toHaveLength(2);
    expect(part.powerStates!.map((s) => s.unit)).toEqual(["µA", "µA"]);
    expect(part.powerStates![0]!.currentTyp).toBe(130);
    expect(part.powerStates![1]!.currentTyp).toBe(5);
  });

  it("reads a Peak column as a max current", () => {
    // "Work Mode | Description | Peak (mA)" is ESP32-C3's Wi-Fi table and the
    // only place its 335 mA TX draw is written. Peak is an upper figure, so it
    // lands on max: calling it typ would understate the burst that the bulk-cap
    // and brownout math exists to catch.
    const part = mapTable(
      table(
        ["Work Mode", "Description", "Peak (mA)"],
        [["Active (RF working)", "802.11b, 1 Mbps, @21 dBm", "335"]],
        56,
      ),
      "power",
    );
    expect(part.powerStates).toHaveLength(1);
    expect(part.powerStates![0]!.currentMax).toBe(335);
    expect(part.powerStates![0]!.currentTyp).toBeNull();
    expect(part.powerStates![0]!.unit).toBe("mA");
  });

  it("does not invent a unit for a value column that states none", () => {
    // The governing rule: a missing number stays missing. A bare "Typ" column in
    // a table with no Unit column is not a current — reading it as one would put
    // an unteathered number into the budget.
    const part = mapTable(
      table(["Parameter", "Typ"], [["Some count", "42"]]),
      "electrical-characteristics",
    );
    expect(part.powerStates ?? []).toHaveLength(0);
  });

  it("carries a vertically merged label onto the rows it spans", () => {
    // Verbatim shape from SX1276 p14. `IDDT | Supply current in Transmit mode`
    // is printed once against four rows differing only by output power, and the
    // PDF has no merged-cell concept — it lands on whichever row it is centred
    // against. The siblings arrive label-less, match no mode, and get dropped.
    // The dropped ones are the extremes, so the real worst-case TX (120 mA at
    // +20 dBm) vanished while the middling 87 mA row survived, quietly making
    // every LoRa budget optimistic.
    const part = mapTable(
      table(
        ["Symbol", "Description", "Conditions", "Typ", "Unit"],
        [
          ["IDDR", "Supply current in Receive mode", "LnaBoost On, band 1", "11.5", "mA"],
          ["", "", "Bands 2&3", "12.0", ""],
          ["", "", "RFOP = +20 dBm, on PA_BOOST", "120", ""],
          ["IDDT", "Supply current in Transmit mode", "RFOP = +17 dBm, on PA_BOOST", "87", "mA"],
        ],
      ),
      "electrical-characteristics",
    );
    const tx = part.powerStates!.filter((s) => s.mode === "tx");
    expect(Math.max(...tx.map((s) => s.currentTyp!))).toBe(120);
    // the unit is merged too, and rides along only because the label was carried
    expect(tx.every((s) => s.unit === "mA")).toBe(true);
    // carried rows stay distinguishable, or they would collapse onto one another
    expect(new Set(tx.map((s) => s.name)).size).toBe(tx.length);
    // the row above the label is carried the same way as the rows below it
    expect(part.powerStates!.find((s) => s.currentTyp === 12)!.mode).toBe("rx");
  });

  it("refuses to attribute a row sitting between two labels", () => {
    // SX1276 p19: a label wraps across two lines and is centred in its group, so
    // spacing alone cannot say which side an interior row belongs to. Guessing
    // there is how a receive current gets filed as a transmit current. This
    // codebase's rule is that an unattributed row is handed to the vision tier,
    // while a misattributed one silently poisons the library — so refusal wins.
    const part = mapTable(
      table(
        ["Symbol", "Description", "Conditions", "Typ", "Unit"],
        [
          ["IDDR_L", "Supply current in receiver LoRa mode", "Bands 2&3, BW = 500 kHz", "13.8", "mA"],
          ["", "", "Band 1, BW = 250 kHz", "11.1", "mA"],
          ["IDDT_L", "Supply current in transmitter mode", "RFOP = 13 dBm", "28", "mA"],
        ],
      ),
      "electrical-characteristics",
    );
    const ambiguous = part.powerStates!.find((s) => s.currentTyp === 11.1)!;
    expect(ambiguous.mode).toBeUndefined();
    expect(ambiguous.name).not.toContain("transmitter");
  });

  it("never carries a label into a pin table", () => {
    // every pin states its own name, so a blank name is a missing pin, not an
    // inherited one — carrying here would invent duplicate pins
    const part = mapTable(
      table(["Pin", "Name", "Description"], [["1", "VDD", "Power supply"], ["2", "", ""]]),
      "pinout",
    );
    expect(part.pins!.map((p) => p.name)).toEqual(["VDD"]);
  });

  // SX1262 p16 shape: the state lives in its own Mode column and nowhere else —
  // the symbol is "IDDSL" and the conditions say "Configuration retained".
  it("reads the operating state from a dedicated Mode column", () => {
    const part = mapTable(
      table(
        ["Symbol", "Mode", "Conditions", "Min", "Typ", "Max", "Unit"],
        [
          ["IDDOFF", "SLEEP mode with cold start", "All blocks off", "-", "160", "-", "nA"],
          ["IDDSL", "SLEEP mode with warm start", "Configuration retained", "-", "600", "-", "nA"],
          ["IDDSBR", "STDBY_RC mode", "RC13M, XOSC OFF", "-", "0.6", "-", "mA"],
          ["IDDSBX", "STDBY_XOSC mode", "XOSC ON", "-", "0.8", "-", "mA"],
          ["IDDRX", "Receive mode", "LoRa® 125 kHz", "-", "8.8", "-", "mA"],
        ],
        16,
      ),
      "power",
    );
    expect(part.powerStates?.map((p) => p.mode)).toEqual([
      "sleep",
      "sleep",
      "standby", // STDBY_RC — Semtech never spells "standby" out
      "standby",
      "rx",
    ]);
    // the mode column also distinguishes the two sleep rows from each other
    const names = part.powerStates?.map((p) => p.name) ?? [];
    expect(names[0]).toContain("cold start");
    expect(names[1]).toContain("warm start");
    expect(new Set(names).size).toBe(5);
  });

  it("carries a merged Mode label across the rows it spans", () => {
    const part = mapTable(
      table(
        ["Symbol", "Mode", "Conditions", "Typ", "Unit"],
        [
          ["IDDRX", "Receive mode", "FSK 4.8 kb/s", "8", "mA"],
          ["", "", "LoRa® 125 kHz", "8.8", "mA"],
          ["", "", "Rx Boosted, FSK 4.8 kb/s", "9.3", "mA"],
        ],
        16,
      ),
      "power",
    );
    // all three are receive currents; only the first one says so on its own row
    expect(part.powerStates?.map((p) => p.mode)).toEqual(["rx", "rx", "rx"]);
    expect(part.powerStates?.map((p) => p.currentTyp)).toEqual([8, 8.8, 9.3]);
  });

  it("maps a pin table, inferring functions from pin names", () => {
    const part = mapTable(
      table(
        ["Pin", "Name", "Description"],
        [
          ["1", "VDD", "Power supply"],
          ["2", "GND", "Ground"],
          ["5", "SDA", "Serial data (I2C)"],
        ],
      ),
      "pinout",
    );
    expect(part.pins).toHaveLength(3);
    expect(part.pins!.find((p) => p.name === "VDD")).toMatchObject({ number: "1", functions: ["supply"] });
    expect(part.pins!.find((p) => p.name === "GND")?.functions).toEqual(["ground"]);
    expect(part.pins!.find((p) => p.name === "SDA")?.functions).toEqual(["i2c-sda"]);
  });

  it("maps an ordering table to variants, picking the part-number cell as the code", () => {
    const part = mapTable(
      table(
        ["Ordering code", "Flash", "Package"],
        [["STM32F103C8T6", "64 KB", "LQFP48"]],
      ),
      "ordering",
    );
    expect(part.variants).toHaveLength(1);
    expect(part.variants![0]!.orderingCode).toBe("STM32F103C8T6");
    expect(part.variants![0]!.attrs).toEqual({ flash: "64 KB", package: "LQFP48" });
  });
});

// ---- end-to-end against a fake PDF made of synthetic positioned text --------

function item(str: string, x: number, y: number, width: number, height = 9.96): PositionedText {
  return { str, x, y, width, height, rotated: false };
}

/** An abs-max table laid out with real coordinates so extractTables runs for real. */
function absMaxPageItems(): PositionedText[] {
  return [
    // distant running header so the table's own header isn't self-excluded as furniture
    item("Bosch Sensortec  BME280", 100, 800, 140),
    // header row
    item("Symbol", 100, 500, 40),
    item("Parameter", 180, 500, 60),
    item("Min", 340, 500, 20),
    item("Max", 400, 500, 20),
    item("Unit", 460, 500, 25),
    // VDD row
    item("VDD", 100, 470, 30),
    item("Supply voltage", 180, 470, 70),
    item("-0.3", 340, 470, 22),
    item("4.25", 400, 470, 25),
    item("V", 460, 470, 8),
    // storage-temperature row
    item("Tstg", 100, 450, 28),
    item("Storage temperature", 180, 450, 95),
    item("-45", 340, 450, 20),
    item("85", 400, 450, 16),
    item("degC", 460, 450, 22),
  ];
}

function fakePdf(pages: Record<number, { text: string; items: PositionedText[] }>): LoadedPdf {
  const pageCount = Object.keys(pages).length;
  return {
    pageCount,
    outline: async () => [], // no outline → keyword triage path
    pageText: async (p: number) => pages[p]?.text ?? "",
    pageItems: async (p: number) => pages[p]?.items ?? [],
    // US Letter, matching the synthetic y coordinates these fixtures use
    pageHeight: async () => 792,
  } as unknown as LoadedPdf;
}

describe("extractDeterministic", () => {
  it("triages by keywords, reads the table, and reports the page as handled with zero gaps", async () => {
    const pdf = fakePdf({
      1: { text: "BME280 Combined humidity pressure temperature sensor", items: [] },
      2: {
        text: "Absolute maximum ratings The maximum ratings are given below.",
        items: absMaxPageItems(),
      },
    });

    const result = await extractDeterministic(pdf);

    expect(result.triageSource).toBe("keywords");
    expect(result.sectionMap["2"]).toBe("absolute-max");
    expect(result.handledPages).toEqual([2]);
    expect(result.gapPages).toEqual([]);
    expect(result.tableCount).toBe(1);

    const params = result.fields.absoluteMax.map((r) => r.param);
    expect(params).toContain("vdd");
    expect(params).toContain("tStorage");
    // grounded by construction: no LLM, machine-attributable
    for (const row of result.fields.absoluteMax) {
      expect(row.extractor).toBe("deterministic");
      expect(row.grounding).toBe("verified");
    }
  });

  it("flags a spec page whose text layer is too thin as a vision gap, not a failure", async () => {
    const pdf = fakePdf({
      1: { text: "Cover", items: [] },
      2: {
        // classified pinout by keyword, but only a couple of runs (a scanned drawing)
        text: "Pin-out and connection diagram",
        items: [item("figure", 100, 400, 40)],
      },
    });

    const result = await extractDeterministic(pdf);
    expect(result.sectionMap["2"]).toBe("pinout");
    expect(result.gapPages).toEqual([2]);
    expect(result.handledPages).toEqual([]);
  });
});
