import { z } from "zod";

export const PhaseId = z.enum([
  "scope",
  "architecture",
  "components",
  "electrical",
  "firmware",
  "bringup",
  "optimize",
]);
export type PhaseId = z.infer<typeof PhaseId>;

export const PHASE_ORDER: PhaseId[] = [
  "scope",
  "architecture",
  "components",
  "electrical",
  "firmware",
  "bringup",
  "optimize",
];

export const PhaseState = z.object({
  /** 0..1 completeness shown as a ring in the phase rail */
  completeness: z.number().min(0).max(1).default(0),
  /** phase-specific scratch state (layout positions, collapsed cards, …) */
  ui: z.record(z.unknown()).optional(),
});
export type PhaseState = z.infer<typeof PhaseState>;

export const Project = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(""),
  archetypeId: z.string().nullable().default(null),
  phaseStates: z.record(PhaseId, PhaseState).default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Project = z.infer<typeof Project>;

export const CreateProjectInput = Project.pick({ name: true }).extend({
  description: z.string().optional(),
  archetypeId: z.string().nullable().optional(),
});
export type CreateProjectInput = z.infer<typeof CreateProjectInput>;

export const UpdateProjectInput = z.object({
  name: z.string().trim().min(1).max(200),
});
export type UpdateProjectInput = z.infer<typeof UpdateProjectInput>;
