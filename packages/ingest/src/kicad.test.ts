import { describe, expect, it } from "vitest";
import {
  categoryForLibrary,
  extractSymbols,
  parseSExpr,
  pinFunction,
  pinFunctionByName,
  symbolToComponent,
} from "./kicad.js";

/**
 * A faithful slice of the .kicad_sym S-expression format: a base sensor symbol
 * with power/ground/I²C/interrupt/NC pins, and a derived `(extends …)` symbol —
 * the family/variant case. Values mirror how KiCad actually writes libraries
 * (property triples, pins on a child unit symbol, empty datasheet as "~").
 */
const LIB = `
(kicad_symbol_lib
  (version 20211014) (generator kicad_symbol_editor)
  (symbol "BME280"
    (in_bom yes) (on_board yes)
    (property "Reference" "U" (at 0 0 0))
    (property "Value" "BME280" (at 0 0 0))
    (property "Footprint" "Package_LGA:Bosch_LGA-8_2.5x2.5mm" (at 0 0 0))
    (property "Datasheet" "https://www.bosch-sensortec.com/bme280.pdf" (at 0 0 0))
    (property "ki_keywords" "humidity pressure temperature sensor I2C SPI" (at 0 0 0))
    (property "ki_description" "Combined humidity, pressure and temperature sensor" (at 0 0 0))
    (symbol "BME280_0_1"
      (rectangle (start -7.62 7.62) (end 7.62 -7.62)))
    (symbol "BME280_1_1"
      (pin power_in line (at -10.16 5.08 0) (length 2.54)
        (name "VDD" (effects (font (size 1.27 1.27))))
        (number "1" (effects (font (size 1.27 1.27)))))
      (pin power_in line (at -10.16 2.54 0) (length 2.54)
        (name "GND" (effects (font (size 1.27 1.27))))
        (number "2" (effects (font (size 1.27 1.27)))))
      (pin bidirectional line (at 10.16 5.08 180) (length 2.54)
        (name "SDA" (effects (font (size 1.27 1.27))))
        (number "5" (effects (font (size 1.27 1.27)))))
      (pin input line (at 10.16 2.54 180) (length 2.54)
        (name "SCL" (effects (font (size 1.27 1.27))))
        (number "4" (effects (font (size 1.27 1.27)))))
      (pin no_connect line (at 10.16 0 180) (length 2.54)
        (name "NC" (effects (font (size 1.27 1.27))))
        (number "6" (effects (font (size 1.27 1.27)))))))
  (symbol "BMP280"
    (extends "BME280")
    (property "Value" "BMP280" (at 0 0 0))
    (property "Datasheet" "~" (at 0 0 0))
    (property "ki_description" "Pressure and temperature sensor (no humidity)" (at 0 0 0))))
`;

describe("parseSExpr", () => {
  it("parses nested lists, quoted strings and bare atoms", () => {
    const tree = parseSExpr('(a "hello world" (b 1.27) c)');
    expect(tree).toEqual(["a", "hello world", ["b", "1.27"], "c"]);
  });

  it("handles escaped quotes inside strings", () => {
    expect(parseSExpr('(x "a\\"b")')).toEqual(["x", 'a"b']);
  });
});

describe("extractSymbols", () => {
  const symbols = extractSymbols(parseSExpr(LIB));

  it("finds both the base and the derived symbol", () => {
    expect(symbols.map((s) => s.name)).toEqual(["BME280", "BMP280"]);
  });

  it("reads properties, keywords and the datasheet URL of the base", () => {
    const bme = symbols[0]!;
    expect(bme.value).toBe("BME280");
    expect(bme.datasheet).toBe("https://www.bosch-sensortec.com/bme280.pdf");
    expect(bme.footprint).toContain("LGA-8");
    expect(bme.description).toContain("humidity");
  });

  it("gathers pins from the child unit symbol", () => {
    const bme = symbols[0]!;
    expect(bme.pins).toHaveLength(5);
    expect(bme.pins.find((p) => p.number === "1")).toMatchObject({ name: "VDD", electricalType: "power_in" });
    expect(bme.pins.find((p) => p.name === "NC")).toMatchObject({ electricalType: "no_connect" });
  });

  it("records the base a derived symbol extends and drops an empty '~' datasheet", () => {
    const bmp = symbols[1]!;
    expect(bmp.extends).toBe("BME280");
    expect(bmp.datasheet).toBeUndefined();
    expect(bmp.pins).toHaveLength(0); // inherited, not repeated
  });
});

describe("pinFunction", () => {
  it.each([
    [{ name: "VDD", number: "1", electricalType: "power_in" }, "supply"],
    [{ name: "GND", number: "2", electricalType: "power_in" }, "ground"],
    [{ name: "VSSA", number: "3", electricalType: "power_in" }, "ground"],
    [{ name: "SDA", number: "5", electricalType: "bidirectional" }, "i2c-sda"],
    [{ name: "SCL", number: "4", electricalType: "input" }, "i2c-scl"],
    [{ name: "SCK", number: "7", electricalType: "input" }, "spi-sck"],
    [{ name: "NRST", number: "8", electricalType: "input" }, "reset"],
    [{ name: "PA5", number: "9", electricalType: "bidirectional" }, "gpio"],
    [{ name: "NC", number: "6", electricalType: "no_connect" }, "nc"],
  ] as const)("maps %o to %s", (pin, fn) => {
    expect(pinFunction(pin)).toBe(fn);
  });
});

describe("pinFunctionByName", () => {
  it("classifies by name alone, returning undefined when nothing matches", () => {
    expect(pinFunctionByName("VDD")).toBe("supply");
    expect(pinFunctionByName("GND")).toBe("ground");
    expect(pinFunctionByName("SDA")).toBe("i2c-sda");
    expect(pinFunctionByName("PA5")).toBeUndefined();
  });
});

describe("categoryForLibrary", () => {
  it.each([
    ["Sensor_Pressure", "sensor"],
    ["MCU_ST_STM32F1", "mcu"],
    ["RF_Module", "radio"],
    ["Regulator_Linear", "power"],
    ["Connector_Generic", "connector"],
    ["Some_Unknown_Lib", "other"],
  ] as const)("maps %s to %s", (lib, category) => {
    expect(categoryForLibrary(lib)).toBe(category);
  });
});

describe("extractSymbols pin dedup", () => {
  it("collapses De Morgan body-style pin duplicates but keeps distinct per-unit pins", () => {
    const lib = `
      (kicad_symbol_lib (version 20251024) (generator "x")
        (symbol "G"
          (property "Value" "G" (at 0 0 0))
          (symbol "G_1_1"
            (pin input line (at 0 0 0) (name "A") (number "1"))
            (pin output line (at 0 0 0) (name "Y") (number "3")))
          (symbol "G_1_2"
            (pin input line (at 0 0 0) (name "A") (number "1"))
            (pin output line (at 0 0 0) (name "Y") (number "3")))
          (symbol "G_2_0"
            (pin power_in line (at 0 0 0) (name "VDD") (number "14")))))`;
    const [sym] = extractSymbols(parseSExpr(lib));
    expect(sym!.pins.map((p) => p.number).sort()).toEqual(["1", "14", "3"]);
  });
});

describe("symbolToComponent", () => {
  const symbols = extractSymbols(parseSExpr(LIB));

  it("builds a standalone component with classified pins and the datasheet URL in variantAttrs", () => {
    const comp = symbolToComponent(symbols[0]!, { manufacturer: "Bosch" });
    expect(comp.mpn).toBe("BME280");
    expect(comp.manufacturer).toBe("Bosch");
    expect(comp.specs?.pins?.find((p) => p.name === "VDD")?.functions).toEqual(["supply"]);
    expect(comp.specs?.pins?.find((p) => p.name === "GND")?.functions).toEqual(["ground"]);
    expect(comp.specs?.pins?.find((p) => p.name === "SDA")?.functions).toEqual(["i2c-sda"]);
    expect(comp.variantAttrs?.["datasheet"]).toContain("bme280.pdf");
    expect(comp.familyId).toBeUndefined();
  });

  it("links a derived symbol to its base as a family variant, inheriting the base pins", () => {
    const base = symbolToComponent(symbols[0]!);
    const variant = symbolToComponent(symbols[1]!, {
      resolveBase: (name) => (name === "BME280" ? { id: "comp-base", pins: symbols[0]!.pins } : undefined),
    });
    expect(base.mpn).toBe("BME280");
    expect(variant.mpn).toBe("BMP280");
    expect(variant.familyId).toBe("comp-base");
    // the variant carried no pins of its own; it inherits the base's five
    expect(variant.specs?.pins).toHaveLength(5);
    expect(variant.specs?.pins?.find((p) => p.name === "SCL")?.functions).toEqual(["i2c-scl"]);
  });
});
