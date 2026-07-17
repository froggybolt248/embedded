import { PinFunction, type DatasheetSection } from "@embedded/core";

/**
 * Bump whenever any prompt changes — stored on every ExtractionRun so the
 * accuracy harness can compare prompt versions against the golden fixtures.
 */
export const PROMPT_VERSION = "v6";

export const TRIAGE_SYSTEM = [
  "You classify datasheet pages by section. You are given one line per page:",
  'the page number and the beginning of that page\'s text layer.',
  "Classify EVERY page into exactly one of:",
  "- absolute-max: absolute maximum ratings tables",
  "- recommended-operating: recommended operating conditions",
  "- electrical-characteristics: DC/AC electrical characteristics tables",
  "- power: current consumption, power modes, sleep/standby currents",
  "- pinout: pin assignments, pin descriptions, pin functions",
  "- package: mechanical drawings, dimensions, land patterns, reflow",
  "- application: application circuits, layout guidance, decoupling recommendations",
  "- ordering: ordering information, part-number tables, product selector tables",
  "- other: everything else (cover, TOC, revision history…)",
  "When a page holds several, pick the section whose tables dominate the page.",
  "A page carrying ANY rated-parameter table — recognisable by Symbol/Condition",
  "or Min/Typ/Max columns — is NEVER `other`, even when the page is titled",
  "generically (\"Specification\", \"Overview\"). Classify it by what the table",
  "rates: supply/interface voltages and DC/AC limits → electrical-characteristics.",
].join("\n");

export function triagePrompt(pageSummaries: Array<{ page: number; text: string }>): string {
  const lines = pageSummaries.map(
    (p) => `p.${p.page}: ${p.text.slice(0, 1200) || "(no text layer — likely a drawing)"}`,
  );
  return `Classify each page of this datasheet:\n\n${lines.join("\n")}`;
}

const EXTRACT_COMMON = [
  "You extract structured specifications from datasheet pages. You are given",
  "page images plus each page's raw text layer.",
  "HARD RULES:",
  "1. Only report values you can actually see. NEVER guess, average, or infer.",
  "2. Every entry must include the page number it came from and a short",
  "   verbatim snippet of the source row/sentence (copy the text, ≤300 chars).",
  "3. Numbers go in min/typ/max (or currentTyp/currentMax) as plain numbers;",
  "   the unit goes in `unit` exactly as printed (µA stays µA, not uA).",
  "4. Record test conditions (VDD, temperature, mode) in `conditions` when the",
  "   table states them.",
  "5. If a section has nothing to extract, return an empty array for it.",
  "6. Set `confidence` below 0.8 when the table is hard to read.",
].join("\n");

export const SECTION_SYSTEM: Partial<Record<DatasheetSection, string>> = {
  "absolute-max": `${EXTRACT_COMMON}\nExtract the ABSOLUTE MAXIMUM RATINGS table into \`absoluteMax\`. Use canonical param ids: vdd, vio, vin, tStorage, esd… Also extract \`identity\` (part number, manufacturer, one-line description) if visible.`,
  "recommended-operating": `${EXTRACT_COMMON}\nExtract RECOMMENDED OPERATING CONDITIONS into \`recommendedOperating\` (param ids: vdd, vio, tOperating, humidity…).`,
  "electrical-characteristics": `${EXTRACT_COMMON}\nExtract from the electrical characteristics tables: supply-current rows into \`powerStates\` (name them by mode: sleep, standby, active, measuring…), everything else voltage/timing-like into \`recommendedOperating\`. Digital interface specs (I2C address, max clock, SPI modes) go into \`interfaces\`.`,
  power: `${EXTRACT_COMMON}\nExtract every operating-mode current into \`powerStates\` (sleep, standby, idle, active, rx, tx, refresh…). One entry per mode+condition row.`,
  pinout: `${EXTRACT_COMMON}
Extract the pin table into \`pins\`: name exactly as printed, pin number as printed,
\`functions\`, and voltage domain if stated.
\`functions\` describes what the pin DOES. Use ONLY these exact values:
  ${PinFunction.options.join(", ")}
Map the datasheet's prose onto them — "Power supply" → supply, "Chip select" →
spi-cs, "Serial data in / SDA" → spi-sdi + i2c-sda. Never invent a value and never
write a description; anything outside the list is rejected.
NEVER echo the pin's own name as its function: pin "GND" has function ["ground"],
not ["GND"]; pin "VDD" has ["supply"], not ["VDD"]. A pin that is muxed lists every
function it can serve. Use \`nc\` only for pins the datasheet marks not-connected.
Interface capabilities you can conclude directly from pin functions go into \`interfaces\`.`,
  application: `${EXTRACT_COMMON}\nExtract decoupling/bypass capacitor recommendations into \`decoupling\` (description + value + unit). Only what the datasheet explicitly recommends.`,
  ordering: `${EXTRACT_COMMON}
Extract the ordering-information table into \`variants\`: one entry per ORDERABLE
part number. \`orderingCode\` is the code exactly as printed (e.g. "STM32F103C8T6").
\`attrs\` holds only what DISTINGUISHES that part from its siblings, as printed —
typically flash/RAM size, package, temperature grade, tape-and-reel suffix
(e.g. { "flash": "64 KB", "package": "LQFP48", "tempGrade": "-40..85 °C" }).
A datasheet describing a single part has no such table: return an empty array
rather than inventing one entry for the part itself. Never expand a wildcard
pattern ("STM32F103x8") into codes the table does not literally print.
Also extract \`identity\` (the family part number, manufacturer) if visible.`,
};

export function sectionPrompt(section: DatasheetSection, pages: Array<{ page: number; text: string }>): string {
  const textBlocks = pages
    .map((p) => `--- page ${p.page} text layer ---\n${p.text.slice(0, 4000)}`)
    .join("\n\n");
  return [
    `Section: ${section}. The attached images are datasheet pages ${pages
      .map((p) => p.page)
      .join(", ")} in order.`,
    textBlocks,
  ].join("\n\n");
}
