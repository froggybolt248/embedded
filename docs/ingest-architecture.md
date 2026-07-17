# Datasheet ingest: the tiered ladder

## The problem

The original pipeline made the LLM the *reader*: every page went to a vision
model. On a 60-page datasheet that is ~5 triage calls plus ~15 vision calls at
90–300 s each — roughly 7 minutes per datasheet locally, and unusable for the
hundreds of datasheets a real parts library needs.

Almost everything that pipeline asked a model to do is recoverable
**deterministically from the PDF itself**, in milliseconds, for free. Two
production bugs made the point sharply:

- The model returned rows with a correct label, unit, page and a snippet that
  still contained the numbers — and no numbers, because the JSON schema let it
  omit them.
- The model cited a *noise-table caption* for a current spec. The value was
  right; the citation was invented.

Both are failures of asking a model to retype text that was already
machine-readable. So don't ask.

## The ladder

Each tier handles only what the tier below could not.

| Tier | Cost | What it does | Fallback trigger |
|---|---|---|---|
| **0** | µs, free | Outline → page→section map; keyword classifier when there is no outline; identity; family detection | outline absent or too sparse → keywords; no strong keyword → tier 3 for that page |
| **1** | ms, free | Coordinate table extraction from the text layer. Rows are **verbatim by construction** | no usable text layer, or table detection fails on a spec page |
| **2** | seconds, local text LLM | Normalize candidate rows → canonical params/units/conditions. Small prompts, **no vision** | — |
| **3** | minutes, vision LLM | The original path, demoted to a fallback | — |

**Tier 1 rows are grounded by construction.** The value is parsed from the cell
that the citation points at, so there is no transcription step in which a model
could drift. That is what earns them `verifiedBy: 'machine'` on the trust
ladder — not a promise, a property.

`verify.ts`'s grounding check exists for tier-2/3 output, where a model *did*
do the transcribing. It is not run against tier-1 rows: cell-scoped parsing
knows a cell is one value (so `"20 000"` → 20000), while free-text scanning must
not merge adjacent numbers (`"-45 85"` must never become -4585).

## Why whitespace gutters, not alignment voting

pdfplumber's documented `text` strategy clusters word left/right/center edges
and requires ≥3 votes. Measured against the real BME280 geometry, left-edge
voting **fails**: on p13 the Max column's left edges scatter across 19 pt
(420.72, 429.6, 435.12, 439.32) because the column is *center*-aligned — every
one of those shares center 444.8.

Projecting item spans onto the x-axis instead yields unambiguous empty bands:

- p8: `77-144, 188-217, 235-327, 353-372, 407-424, 459-479, 509-528`
- p13: `77-197, 249-326, 367-385, 420-469, 491-511`

Simpler and more accurate on the actual data. This is our own algorithm derived
from real geometry, not a port, so there is no attribution obligation.

Assigning cells by **column position** rather than by order is what makes the
hard cases correct. BME280 p8's sleep-current row has no Min value: `"0.1"` sits
at center 416 (the Typ column) and `"0.3"` at center 469 (Max). By position →
`typ=0.1, max=0.3` ✓. By order → `min=0.1, typ=0.3` ✗ — plausible and wrong.

## Where the boundary sits

`tables.ts` does **faithful geometric transcription, not semantic resolution.**

BME280 p8 proves the boundary is necessary: "Power supply rejection ratio (DC)"
wraps across two rows *while the second row also carries its own data*
(`±5 Pa/V`). No geometric rule resolves that. Tier 1 emits what is on the page
with coordinates; tier 2 decides what it means. This keeps the deterministic
layer honest and testable, and gives the LLM a job it is actually good at.

## Multi-component and family datasheets

Most datasheets do not describe one part. `Component` carries `familyId`
(nullable self-reference), `isFamily`, `orderingCode` and `variantAttrs`; the
family row holds shared specs and a variant holds only what differs.
`resolveSpecs(variant, family)` layers them, matching rows by identity key
(`param`, `name`, `kind`). A standalone part keeps `familyId: null` and behaves
exactly as before, so nothing migrates.

The **ordering-information table is a first-class extraction target** (its own
`ordering` section) because it is the document's own machine-readable
enumeration of the family — the difference between ingesting a datasheet as one
component and as the thirty parts it documents.

Cases covered: parametric families (STM32F103x8/xB), sibling families
(BMP280/BME280), per-package limit differences, multi-product documents.

## Dependency decisions (this project is intended to be open-sourced)

- **`mupdf` — rejected, AGPL.** Technically the best option: its
  `toStructuredText("preserve-spans").asJSON()` returns text pre-grouped into
  blocks→lines→spans and would remove most clustering work. AGPL is viral and a
  one-way door. Not worth it.
- **`pdfexcavator` — rejected.** Pins `pdfjs-dist ^4.7.76` against our v6.1.200,
  and its borderless-table claim is unverified on an 8-star, 16-commit package.
- Also evaluated: `unpdf` (repackaged pdfjs, no extra structure),
  `@hyzyla/pdfium` (MIT, but would replace pdfjs for unclear gain),
  `@opendocsg/pdf2md` (lossy, drops coordinates), Docling (no JS port).
  `tesseract.js` (Apache-2.0) is available if OCR is ever needed.
- **No parametric-data shortcut exists.** Digi-Key and Mouser ToS explicitly
  forbid building your own database; Nexar's free tier caps at 1,000 parts for
  life; LCSC has no API and no real parametric fields; SnapEDA files are CC BY-SA
  but its ToS bars aggregation; Wikidata is CC0 and empty of this data. PDF
  parsing is the only path.
- **`kicad-symbols`** (permissive, bulk-cloneable) gives pin names/numbers/
  functions — a genuine future cross-check for pinouts, our weakest path.
