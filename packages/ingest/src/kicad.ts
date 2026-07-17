import { ComponentCategory, type CreateComponentInput, type PinFunction } from "@embedded/core";

/**
 * Bulk component acquisition from KiCad symbol libraries (`.kicad_sym`).
 *
 * PDF extraction is inherently one datasheet at a time; it will never seed a
 * library of thousands. KiCad's symbol libraries are permissively licensed,
 * bulk-cloneable, and already structured — thousands of parts with pin
 * names/numbers/functions and, on many symbols, a datasheet URL. Pins are the
 * single hardest thing to recover from a datasheet PDF (they are often a
 * drawing, not a table); KiCad hands them over for free.
 *
 * So this is the breadth channel: import skeletons — identity, pins, package,
 * datasheet URL — for the whole library at once, then let the PDF pipeline
 * deepen electrical specs on demand for the parts a user actually designs with.
 *
 * The format is S-expressions. A derived symbol — `(extends "BASE")` — is a
 * part that shares BASE's pins and differs only in a few properties: exactly
 * the family/variant relationship the domain model already carries, so a
 * derived symbol maps to a variant with `familyId` set to its base.
 */

// ---- S-expression parser --------------------------------------------------

export type SExpr = string | SExpr[];

/**
 * Parse KiCad's S-expression dialect: parenthesised lists, bare atoms, and
 * double-quoted strings with backslash escapes. Returns the top-level list.
 */
export function parseSExpr(text: string): SExpr {
  let i = 0;

  const skipWs = (): void => {
    while (i < text.length && /\s/.test(text[i] as string)) i++;
  };

  const parseString = (): string => {
    i++; // opening quote
    let out = "";
    while (i < text.length) {
      const ch = text[i] as string;
      if (ch === "\\") {
        const next = text[i + 1] as string;
        out += next === "n" ? "\n" : next === "t" ? "\t" : next;
        i += 2;
        continue;
      }
      if (ch === '"') {
        i++;
        return out;
      }
      out += ch;
      i++;
    }
    return out;
  };

  const parseList = (): SExpr[] => {
    i++; // opening paren
    const list: SExpr[] = [];
    for (;;) {
      skipWs();
      if (i >= text.length) break;
      const ch = text[i] as string;
      if (ch === ")") {
        i++;
        break;
      }
      if (ch === "(") list.push(parseList());
      else if (ch === '"') list.push(parseString());
      else {
        let atom = "";
        while (i < text.length && !/[\s()"]/.test(text[i] as string)) {
          atom += text[i];
          i++;
        }
        list.push(atom);
      }
    }
    return list;
  };

  skipWs();
  if (text[i] !== "(") throw new Error("kicad: expected '(' at top level");
  return parseList();
}

const isList = (e: SExpr | undefined): e is SExpr[] => Array.isArray(e);
const head = (e: SExpr): string | undefined => (isList(e) ? (typeof e[0] === "string" ? e[0] : undefined) : undefined);

/** Direct children of `node` whose head symbol is `tag`. */
function children(node: SExpr[], tag: string): SExpr[][] {
  return node.filter((c): c is SExpr[] => isList(c) && head(c) === tag);
}

/** First child with head `tag`, if any. */
function child(node: SExpr[], tag: string): SExpr[] | undefined {
  return children(node, tag)[0];
}

/** A `(property "Key" "Value" …)` lookup, case-insensitive on the key. */
function property(symbol: SExpr[], key: string): string | undefined {
  for (const prop of children(symbol, "property")) {
    if (typeof prop[1] === "string" && prop[1].toLowerCase() === key.toLowerCase()) {
      return typeof prop[2] === "string" ? prop[2] : undefined;
    }
  }
  return undefined;
}

// ---- symbol → component ---------------------------------------------------

export interface KicadPin {
  name: string;
  number: string;
  /** KiCad electrical type: power_in, output, bidirectional, no_connect… */
  electricalType: string;
}

export interface KicadSymbol {
  name: string;
  /** set when this is a derived symbol: the base it `extends` */
  extends?: string;
  value?: string;
  datasheet?: string;
  description?: string;
  keywords?: string;
  footprint?: string;
  pins: KicadPin[];
}

/** A datasheet property KiCad leaves blank shows up as this literal. */
const EMPTY_DATASHEET = /^(~|)$/;

/**
 * Pull every symbol from a parsed `.kicad_sym` library. Pins live on child
 * unit-symbols (`(symbol "NAME_1_1" (pin …))`), so they are gathered from one
 * level down; derived symbols carry no pins of their own and inherit them.
 */
export function extractSymbols(root: SExpr): KicadSymbol[] {
  if (!isList(root) || head(root) !== "kicad_symbol_lib") {
    throw new Error("kicad: not a kicad_symbol_lib");
  }

  const out: KicadSymbol[] = [];
  for (const symbol of children(root, "symbol")) {
    const name = typeof symbol[1] === "string" ? symbol[1] : undefined;
    if (name === undefined) continue;

    // Pins live on child unit-symbols named `<sym>_<unit>_<bodyStyle>`. Two
    // things there need care: a multi-unit part (e.g. a quad gate) spreads its
    // pins across several units — all real, keep them — but the De Morgan
    // alternate body style REPEATS a unit's pins under the same numbers, so
    // deduping by pin number drops those phantoms while preserving the genuine
    // per-unit pins (whose numbers are distinct).
    const pins: KicadPin[] = [];
    const seenNumbers = new Set<string>();
    for (const unit of children(symbol, "symbol")) {
      for (const pin of children(unit, "pin")) {
        const electricalType = typeof pin[1] === "string" ? pin[1] : "unspecified";
        const nameNode = child(pin, "name");
        const numberNode = child(pin, "number");
        const number = typeof numberNode?.[1] === "string" ? numberNode[1] : "";
        if (number !== "" && seenNumbers.has(number)) continue;
        if (number !== "") seenNumbers.add(number);
        pins.push({
          name: typeof nameNode?.[1] === "string" ? nameNode[1] : "",
          number,
          electricalType,
        });
      }
    }

    const extendsNode = child(symbol, "extends");
    const extendsName = typeof extendsNode?.[1] === "string" ? extendsNode[1] : undefined;
    const datasheet = property(symbol, "Datasheet");
    const value = property(symbol, "Value");
    const description = property(symbol, "ki_description") ?? property(symbol, "Description");
    const keywords = property(symbol, "ki_keywords");
    const footprint = property(symbol, "Footprint");
    out.push({
      name,
      ...(extendsName !== undefined ? { extends: extendsName } : {}),
      ...(value !== undefined ? { value } : {}),
      ...(datasheet !== undefined && !EMPTY_DATASHEET.test(datasheet) ? { datasheet } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(keywords !== undefined ? { keywords } : {}),
      ...(footprint !== undefined ? { footprint } : {}),
      pins,
    });
  }
  return out;
}

// ---- pin function inference ----------------------------------------------

/** Name patterns → canonical pin function, tried in order (specific first). */
const PIN_NAME_RULES: Array<{ pattern: RegExp; fn: PinFunction }> = [
  { pattern: /^(gnd|vss|vssa|agnd|dgnd|ground)$/i, fn: "ground" },
  { pattern: /^(vdd|vcc|vdda|vddio|vbat|vin|vs|v\+|avdd|dvdd|vddd)/i, fn: "supply" },
  { pattern: /(^|\W)(sda|i2c_sda)(\W|$)/i, fn: "i2c-sda" },
  { pattern: /(^|\W)(scl|i2c_scl)(\W|$)/i, fn: "i2c-scl" },
  { pattern: /(^|\W)(sck|sclk|spck)(\W|$)/i, fn: "spi-sck" },
  { pattern: /(^|\W)(mosi|sdi|sdo_in|copi)(\W|$)/i, fn: "spi-sdi" },
  { pattern: /(^|\W)(miso|sdo|cipo)(\W|$)/i, fn: "spi-sdo" },
  { pattern: /(^|\W)(nss|ncs|cs|csb|ss)(\W|$)/i, fn: "spi-cs" },
  { pattern: /(^|\W)(tx|txd|uart_tx)(\W|$)/i, fn: "uart-tx" },
  { pattern: /(^|\W)(rx|rxd|uart_rx)(\W|$)/i, fn: "uart-rx" },
  { pattern: /(reset|nrst|^rst)/i, fn: "reset" },
  { pattern: /(^|\W)(int|irq|nint)\d*(\W|$)/i, fn: "interrupt" },
  { pattern: /^(a|ain|adc)\d+$/i, fn: "analog-in" },
];

/**
 * Canonical PinFunction inferred from a pin NAME alone, or undefined when the
 * name matches no known bus/power pattern. Shared with the deterministic
 * datasheet-table path, which recovers a pin's name from the text layer but has
 * no KiCad electrical type to lean on — the name is the only signal both paths
 * hold in common, so the rules live here once.
 */
export function pinFunctionByName(name: string): PinFunction | undefined {
  for (const { pattern, fn } of PIN_NAME_RULES) {
    if (pattern.test(name)) return fn;
  }
  return undefined;
}

/**
 * Map a KiCad pin to a canonical PinFunction. Power pins are split into supply
 * vs ground by name (KiCad types both as `power_in`); signal pins are
 * classified by name where a bus is recognisable, else generic gpio; a
 * `no_connect` type is `nc` regardless of name.
 */
export function pinFunction(pin: KicadPin): PinFunction {
  if (pin.electricalType === "no_connect") return "nc";
  const byName = pinFunctionByName(pin.name);
  if (byName) return byName;
  if (pin.electricalType === "power_in" || pin.electricalType === "power_out") return "supply";
  return "gpio";
}

/**
 * Map a KiCad library (directory) name to a component category. KiCad groups
 * symbols into topically-named libraries — "Sensor_Pressure", "MCU_ST_STM32F1",
 * "RF_Module" — so the library name is a strong, free category signal. Anything
 * unrecognised falls back to "other"; the category is a convenience filter, not
 * a load-bearing spec, so a miss costs nothing.
 */
const LIBRARY_CATEGORY_RULES: Array<{ pattern: RegExp; category: ComponentCategory }> = [
  { pattern: /^(mcu|cpu)_/i, category: "mcu" },
  { pattern: /^sensor/i, category: "sensor" },
  { pattern: /^(rf|radio)/i, category: "radio" },
  { pattern: /^(regulator|power|battery)/i, category: "power" },
  { pattern: /^(driver|motor|relay)/i, category: "actuator-driver" },
  { pattern: /^(display|led)/i, category: "display" },
  { pattern: /^memory/i, category: "memory" },
  { pattern: /^connector/i, category: "connector" },
  { pattern: /^(device|resistor|capacitor|inductor)/i, category: "passive" },
  { pattern: /^(diode|transistor|triac|thyristor)/i, category: "discrete" },
];

export function categoryForLibrary(libraryName: string): ComponentCategory {
  for (const { pattern, category } of LIBRARY_CATEGORY_RULES) {
    if (pattern.test(libraryName)) return category;
  }
  return "other";
}

/**
 * Convert a parsed KiCad symbol into a component-create input. `resolveBase`
 * supplies a derived symbol's base (for pin inheritance and the family link);
 * pass the id assigned to the already-imported base symbol.
 */
export function symbolToComponent(
  symbol: KicadSymbol,
  opts: {
    manufacturer?: string;
    category?: ComponentCategory;
    resolveBase?: (baseName: string) => { id: string; pins: KicadPin[] } | undefined;
  } = {},
): CreateComponentInput {
  const base = symbol.extends !== undefined ? opts.resolveBase?.(symbol.extends) : undefined;
  const sourcePins = symbol.pins.length > 0 ? symbol.pins : (base?.pins ?? []);

  const pins = sourcePins.map((p) => ({
    name: p.name,
    ...(p.number !== "" ? { number: p.number } : {}),
    functions: [pinFunction(p)],
  }));

  const mpn = symbol.value && symbol.value !== "" ? symbol.value : symbol.name;

  return {
    mpn,
    ...(opts.manufacturer !== undefined ? { manufacturer: opts.manufacturer } : {}),
    ...(opts.category !== undefined ? { category: opts.category } : {}),
    ...(symbol.description !== undefined ? { description: symbol.description } : {}),
    ...(base !== undefined ? { familyId: base.id } : {}),
    specs: {
      absoluteMax: [],
      recommendedOperating: [],
      powerStates: [],
      pins,
      interfaces: [],
      decoupling: [],
      extra: {},
    },
    // the datasheet URL rides in variantAttrs until the PDF pipeline fetches
    // and ingests it; keywords/footprint likewise seed later enrichment
    variantAttrs: {
      ...(symbol.datasheet !== undefined ? { datasheet: symbol.datasheet } : {}),
      ...(symbol.footprint !== undefined ? { footprint: symbol.footprint } : {}),
      ...(symbol.keywords !== undefined ? { keywords: symbol.keywords } : {}),
    },
  };
}
