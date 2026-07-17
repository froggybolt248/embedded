# embedded

A local-first, datasheet-grounded workflow app for embedded hardware design: idea → scope → architecture → parts → electrical checks → firmware → bring-up.

Everything runs on your machine. Your parts library is built from datasheets *you* ingest, stored in a local SQLite database, and owned by you.

> **Status: early. Work in progress.** The ingest pipeline, power budgeting, and the wake-cadence question work end-to-end on real vendor datasheets. Schematic export, firmware codegen, and bring-up are not built yet. The UI is a deliberate placeholder.

## The idea

Existing tools stop at the schematic, or hallucinate numbers when they don't know one. The gap this aims at is the *invisible analog rules* — the things no compiler complains about:

- Will this run a year on a coin cell? (Priced from the real per-state currents in each part's datasheet.)
- Does this I²C bus need different pull-ups at 400 kHz? (Usually yes, and the 4.7 kΩ everyone copies is often out of spec.)
- Will this 3.3 V part actually drive that receiver's input? (Depends on its logic family, not its nominal voltage.)

### The rule everything follows

> **A missing number must stay missing. An uncited gap is honest; a confidently cited wrong number is not.**

This is load-bearing, not a slogan. Every number carries provenance back to a datasheet page and a verbatim snippet, and the code refuses to invent plausible values:

- The I²C pull-up calculator reports **no legal resistor exists** rather than clamping to one that looks like an answer.
- Level-shift checks return **unknown** rather than "compatible" when the receiver's VIH wasn't supplied.
- A part whose datasheet couldn't be read is **listed as excluded** from the power budget, never silently skipped.
- An empty design offers **no cadence options** rather than reporting that it runs forever.

The LLM never freehands a numeric spec. Where a model is used, it is schema-constrained and kept off the critical path — the wake-cadence suggestion lives on its own endpoint precisely so a missing or broken provider can never stand between you and an honest answer.

## Stack

Node 22 + TypeScript throughout, pnpm workspaces + Turborepo.

| | |
|---|---|
| Server | Fastify 5 on `127.0.0.1:4517` |
| Data | SQLite (better-sqlite3) + Drizzle; Zod is the single source of truth for domain types, API contracts, and LLM schemas |
| Web | React 19, Vite, TanStack Router/Query, Tailwind |
| Ingest | pdfjs-dist — deterministic, coordinate-based table extraction from the PDF text layer |
| LLM | Pluggable: Ollama (local), Claude Agent SDK, or any OpenAI-compatible endpoint |

Datasheet extraction is **deterministic first**: tables are recovered geometrically from the text layer with no model in the loop, which is what makes bulk ingest free and repeatable. Extractor versions are pinned (`deterministic@dN`) and bumped, never redefined, so a stored value always says which extractor produced it. A vision model is a fallback for the rare scanned page, not the default path.

## Layout

```
apps/server     Fastify API
apps/web        React UI (placeholder, slated for replacement)
packages/core   Zod domain schemas — SourcedValue, the grounding backbone
packages/db     Drizzle schema, migrations, repositories
packages/calc   Power budget, I²C pull-ups, level shift, bulk cap, LoRa airtime
packages/rules  Rule registry + evaluator
packages/ingest PDF table extraction, triage, extraction pipeline
packages/llm    Provider abstraction + grounding validator
seeds/          Archetypes and builtin rules as plain data
```

Rules, calculators, and archetypes are **data, not code** — the app is meant to extend itself without a rebuild.

## Running it

Requires Node 22+ and pnpm.

```bash
pnpm install
pnpm dev        # server on http://127.0.0.1:4517
pnpm test
pnpm typecheck
pnpm test:e2e   # Playwright golden path
```

Your library and settings live in `%APPDATA%/embedded/` (Windows) — never in the repo.

An LLM provider is optional. Ingest, the power budget, and the electrical checks are all deterministic and work with no model configured.

## License

Not yet licensed — all rights reserved for now. If you want to use any of this, open an issue and ask.
