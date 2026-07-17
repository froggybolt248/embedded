import { z } from "zod";
import type { LlmProvider } from "@embedded/llm";
import { BlockRole, InterfaceKind } from "@embedded/core";

/**
 * Proposes a starting block/connection diagram from a project's Requirements
 * — the last M5 assist. MODELED EXACTLY ON `proposeWakeInterval` /
 * `proposeQuantification`: this is a PROPOSAL the user accepts per-item,
 * never auto-applied, and the LLM sits off the critical path entirely — a
 * project with no provider configured, or a provider that fails, simply gets
 * no suggestion (`null`), not an error.
 *
 * Proposed blocks have no IDs yet (they aren't created until the user
 * accepts them), so unlike `Connection` — which references blocks by
 * `fromBlockId`/`toBlockId` — the proposal's connections reference blocks BY
 * NAME. That name-based link is honest only as long as it resolves, so after
 * parsing we enforce referential integrity ourselves: any connection whose
 * `from`/`to` doesn't exactly match a proposed block's `name`, or that
 * connects a block to itself, is dropped rather than surfaced as a dangling
 * or nonsensical edge. If dropping leaves zero blocks, the whole proposal is
 * null — a wrong-but-plausible guess is worse than no guess.
 */

export interface ProposeArchitectureInput {
  requirements: Array<{ text: string; kind?: string | undefined }>;
  /** The project archetype's name, when trivially available. */
  archetypeHint?: string | undefined;
}

export interface ArchitectureProposalBlock {
  name: string;
  role: BlockRole;
  notes?: string | undefined;
}

export interface ArchitectureProposalConnection {
  from: string;
  to: string;
  interface: InterfaceKind;
}

export interface ArchitectureProposal {
  blocks: ArchitectureProposalBlock[];
  connections: ArchitectureProposalConnection[];
}

const ProposedBlockSchema = z.object({
  name: z.string().trim().min(1).max(40),
  role: BlockRole,
  notes: z.string().trim().max(200).optional(),
});

const ProposedConnectionSchema = z.object({
  from: z.string().trim().min(1).max(40),
  to: z.string().trim().min(1).max(40),
  interface: InterfaceKind,
});

// The LLM boundary schema is the only contract that holds — shape (counts,
// enums, lengths) is enforced here structurally. Referential integrity
// between `connections` and `blocks` is NOT expressible in zod (there is no
// cross-array "must match one of these names" constraint), so that half of
// the contract is enforced by `validateReferentialIntegrity` below, after
// parsing.
const ArchitectureProposalSchema = z.object({
  blocks: z.array(ProposedBlockSchema).min(1).max(12),
  connections: z.array(ProposedConnectionSchema).max(24),
});

function buildPrompt(input: ProposeArchitectureInput): string {
  const lines: string[] = ["Requirements:"];
  if (input.requirements.length === 0) {
    lines.push("  (none given)");
  } else {
    for (const r of input.requirements) {
      lines.push(`  - [${r.kind ?? "functional"}] ${r.text}`);
    }
  }
  lines.push(`Archetype: ${input.archetypeHint ?? "(none given)"}`);
  lines.push(
    "",
    "Design a minimal embedded hardware architecture that satisfies these requirements: an " +
      "MCU plus whatever sensors, radios, power sources, actuators, or displays the " +
      "requirements imply. Do not propose blocks the requirements do not call for.",
    "",
    "Each block needs a short `name` (max 40 characters), a `role` (mcu, sensor, radio, " +
      "power, actuator, display, or other), and an optional one-sentence `notes` (max 200 " +
      "characters) saying why it's there.",
    "",
    "Then list `connections` — but ONLY between blocks that are actually wired together: a " +
      "sensor to the MCU over its bus, a radio to the MCU, a power source to every block it " +
      "supplies. Do not connect blocks that have no real electrical relationship. Each " +
      "connection's `from` and `to` MUST be one of the exact `name` values you listed in " +
      "`blocks` — do not invent new names in `connections`, and do not connect a block to " +
      "itself. `interface` is one of i2c, spi, uart, gpio, analog, pwm, usb, rf, power.",
  );
  return lines.join("\n");
}

/**
 * Drop any connection whose `from`/`to` doesn't exactly match a proposed
 * block's name, and any self-loop. Returns null if no blocks survive (there
 * is nothing left to propose) — dropping connections never empties `blocks`,
 * since blocks are never removed here, only connections.
 */
function validateReferentialIntegrity(
  proposal: z.infer<typeof ArchitectureProposalSchema>,
): ArchitectureProposal | null {
  if (proposal.blocks.length === 0) return null;

  const names = new Set(proposal.blocks.map((b) => b.name));
  const connections = proposal.connections.filter(
    (c) => c.from !== c.to && names.has(c.from) && names.has(c.to),
  );

  return { blocks: proposal.blocks, connections };
}

/**
 * Ask the model to propose an architecture from a project's requirements.
 * Returns null — never a partial or guessed fallback — whenever the answer
 * cannot be trusted: no provider configured, the provider throws, the
 * response fails schema validation, or every block turns out invalid.
 *
 * Calls the provider's `extract` exactly once, at the "assistant" tier, same
 * as its siblings — providers already retry once internally on a
 * schema-validation failure.
 */
export async function proposeArchitecture(
  provider: LlmProvider | undefined,
  input: ProposeArchitectureInput,
): Promise<ArchitectureProposal | null> {
  if (!provider) return null;

  try {
    const result = await provider.extract("assistant", {
      schema: ArchitectureProposalSchema,
      schemaName: "propose-architecture",
      system:
        "You design a minimal embedded hardware architecture (blocks and how they connect) " +
        "from a set of product requirements. You only connect blocks that are actually wired " +
        "together, and you only reference blocks by the exact names you propose.",
      prompt: buildPrompt(input),
    });
    return validateReferentialIntegrity(result.data);
  } catch {
    return null;
  }
}
