# DESIGN.md — "Bench"

The visual language for **embedded**. Register: **product** (a tool; design serves the task). One word: *effortless*. The interface is a quiet lab bench — an engineer reads it at a glance and trusts it. Nothing shouts.

## The scene

An embedded engineer at a workbench, a dev board and probes in front of them, often a dim room, cross-referencing a datasheet PDF. A bench instrument *glows*: dark surfaces, one calm light. This forces **dark**, and it is our permanent identity — do not offer a light theme.

## Non-negotiables (identity — never drift)

- **Palette is fixed.** Near-black surfaces (`surface-0..3`), hairline `line`, ink ramp (`ink`/`ink-dim`/`ink-faint`), one teal `accent` (+ `accent-dim`), semantics `ok`/`warn`/`danger`. Defined in `styles.css` `@theme`. Do not introduce new hues.
- **Every number and identifier is mono.** JetBrains Mono via `.num` (adds `tabular-nums`) or `font-mono`. Prose is Inter.
- **A missing number stays missing.** Never render 0 for "not measured/not documented". Absence is honest; a confident wrong number is not. Keep the existing "sleep current not documented" style of copy.
- **Provenance is sacred.** Every datasheet-derived value stays behind `<ProvenancePopover>`. Don't flatten a sourced value into bare text.

## Color strategy: Restrained

Teal `accent` is spent **only** on: the primary action in a context, the current selection, and live/positive state. Never decoration, never a gradient, never on inactive controls. Everything else is the neutral ramp. If two teal things sit in one panel and neither is "the primary action or the current thing", one is wrong.

Semantic color is meaning, not palette: `ok` = grounded/met/pass, `warn` = needs input/at-risk/partial, `danger` = failed/error. Tint backgrounds with the color's own hue at low alpha (`bg-warn/5`, `border-warn/30`), never gray-on-color.

## Type scale (fixed rem, product register)

- `text-xl` (20px) page/project title, `text-sm` (14px) body, `text-xs` (12px) dense UI/labels, `text-[11px]`/`[10px]` metadata. Ratio stays tight — this is a dense tool, not a landing page.
- Panel headers: `text-[11px] font-semibold uppercase tracking-wide text-ink-faint`. These are **functional labels on a dense tool** (Linear/Figma inspectors do this), not decorative eyebrows — legitimate here. Keep them consistent everywhere.
- Big readouts (battery life, average draw): `.num text-2xl font-semibold text-ink` with a smaller `text-ink-dim` unit. This is the one "instrument readout" flourish — use it for the single headline number of a panel, not everywhere.

## Structure & spacing

- **The panel is the unit.** `rounded-lg border border-line bg-surface-1`, header row (`border-b border-line px-4 py-2.5`), body rows (`border-b border-line/60 px-4 py-2.5/3`, `last:border-b-0`), a footer form (`border-t border-line`). This pattern already exists — honor it exactly so every panel is a sibling.
- **No nested cards.** Indent detail with a 1px hairline guide (`border-l border-line pl-2.5`) or plain spacing — never a card inside a card.
- Row hover reveals actions via `group` + `invisible group-hover:visible` (already the idiom). Keep it.
- Radius: `rounded` (6px) controls, `rounded-lg` (8px) panels. No pills except status dots.

## Primitives (in `src/components/ui.tsx`)

Use these instead of re-typing class strings. They encode the rules above:
- `Panel` / `PanelHeader` — the section shell + labeled header (optional right-aligned `aside`).
- `Button` — `variant: primary | ghost | subtle`, `size: sm | md`. Primary is the only teal fill. All variants ship focus-visible ring + disabled state.
- `Field` label+control wrapper; `TextInput` / `Select` — hairline border, `focus:border-accent-dim`, visible focus ring.
- `StatusDot` — 6px dot, semantic color, optional `pulse`.
- `Ring` — SVG completeness ring (phase rail), 0–1 fraction.
- `Readout` — the big mono headline number + unit.
- `EmptyState` — centered teaching copy (never "nothing here").

## Motion (state, not decoration)

- 150–220ms, ease-out (`--ease-out` = cubic-bezier(0.22,1,0.36,1)). Transitions convey state change/feedback only.
- List reveal: a subtle staggered fade-up on first mount of a list is allowed (per-item ~20ms stagger). Never gate content visibility on it — content is visible by default, motion enhances.
- No page-load choreography. The tool loads into work.
- `@media (prefers-reduced-motion: reduce)`: crossfade/instant. Required.

## Layout

- **App shell**: slim ~56px icon rail (Projects / Library / Settings) on list/library/settings routes. On a project route the rail is replaced by the **phase rail** (with a back affordance) so the workspace gets three clean panes.
- **Project workspace**: `[ phase rail ~200 · sticky ] [ workspace · scrolls ] [ inspector ~360 · sticky ]`. The inspector (Power budget + Findings) is the live feedback loop and must never scroll away. Collapses responsively below ~1100px (inspector drops under the workspace; phase rail → compact rings).
- **Architecture** phase owns the **block canvas** (React Flow) inside a fixed-height framed region. Other phases are stacked panel sections the rail scroll-spies.

## Block canvas (React Flow / @xyflow/react)

- Style it to **disappear into Bench** — hide default attribution/controls chrome or restyle to our tokens; canvas bg = `surface-0` with a faint dot grid; nodes are our own component (role badge + name + grounding dot + bound MPN), `surface-2` with `line` border, teal border when selected; edges thin `line`/`accent-dim`, labeled with the interface. Persist node drags to `block.x/y` via `api.blocks.update`. New edge → interface picker → `api.connections.create`.
- Keep it quiet: no minimap unless it earns space, a single unobtrusive zoom control, generous node spacing.

## Bans (on top of the skill's absolute bans)

- No new fonts, no new hues, no gradients, no glass, no >1px colored side-stripes, no hero-metric template, no decorative motion.
- No modals as first thought — inline/progressive first. (A confirm on destructive delete is fine.)
- Don't reinvent form controls; style the native ones.
