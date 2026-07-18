import { z } from "zod";
import { DutyCycle, InterfaceKind } from "./component.js";

export const RequirementKind = z.enum(["functional", "power", "environment", "cost", "size"]);
export type RequirementKind = z.infer<typeof RequirementKind>;

/** Machine-checkable form of a requirement, produced by LLM "quantify". */
export const QuantifiedRequirement = z.object({
  param: z.string(),
  op: z.enum(["<=", ">=", "==", "<", ">"]),
  value: z.number(),
  unit: z.string(),
});
export type QuantifiedRequirement = z.infer<typeof QuantifiedRequirement>;

export const Requirement = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: RequirementKind.default("functional"),
  text: z.string().min(1),
  quantified: QuantifiedRequirement.nullable().default(null),
  status: z.enum(["open", "met", "at-risk"]).default("open"),
  createdAt: z.string(),
});
export type Requirement = z.infer<typeof Requirement>;

export const CreateRequirementInput = Requirement.pick({ text: true }).extend({
  kind: RequirementKind.optional(),
  quantified: QuantifiedRequirement.nullable().optional(),
  status: z.enum(["open", "met", "at-risk"]).optional(),
});
export type CreateRequirementInput = z.infer<typeof CreateRequirementInput>;

export const UpdateRequirementInput = CreateRequirementInput.partial();
export type UpdateRequirementInput = z.infer<typeof UpdateRequirementInput>;

export const BlockRole = z.enum([
  "mcu",
  "sensor",
  "radio",
  "power",
  "actuator",
  "display",
  "other",
]);
export type BlockRole = z.infer<typeof BlockRole>;

export const Block = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.string().min(1),
  role: BlockRole.default("other"),
  componentId: z.string().nullable().default(null),
  notes: z.string().default(""),
  /** canvas position */
  x: z.number().default(0),
  y: z.number().default(0),
  /** The designer's own answer to "how often does this run", per power mode. */
  duties: z.record(z.string(), DutyCycle).default({}),
  /**
   * The designer's own MEASURED current per power mode, in mA — keyed by
   * PowerMode string (not the enum itself, same reasoning as `duties`: a
   * record survives modes that don't exist yet / component-specific modes).
   * A missing key means "not measured", never 0 — provenance here is manual,
   * a designer's claim about what they read off a meter, not a computed value.
   */
  measuredMa: z.record(z.string(), z.number()).default({}),
});
export type Block = z.infer<typeof Block>;

export const CreateBlockInput = Block.pick({ name: true }).extend({
  role: BlockRole.optional(),
  componentId: z.string().nullable().optional(),
  notes: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  duties: z.record(z.string(), DutyCycle).optional(),
  measuredMa: z.record(z.string(), z.number()).optional(),
});
export type CreateBlockInput = z.infer<typeof CreateBlockInput>;

export const UpdateBlockInput = CreateBlockInput.partial();
export type UpdateBlockInput = z.infer<typeof UpdateBlockInput>;

export const ConnectionAttrs = z.object({
  voltage: z.number().optional(),
  busSpeedHz: z.number().optional(),
  /**
   * Total bus capacitance in farads — traces plus every device's pin.
   *
   * Nothing can derive this: it depends on the board that does not exist yet.
   * It stays optional and the pull-up checks report "needs input" without it,
   * because a plausible default here would silently decide whether the bus is in
   * spec. Rough guide for the UI, not for code: ~10 pF per device plus ~1 pF/cm
   * of trace.
   */
  busCapacitanceF: z.number().positive().optional(),
  /** the pull-up resistance actually fitted to this bus, ohms */
  pullupOhms: z.number().positive().optional(),
  /**
   * The real pin at each end, as the designer assigned it — keyed by SIGNAL
   * name (SDA, SCL, SCK, ...; see INTERFACE_SIGNALS in firmware.ts). This is
   * the one place a real pin number is allowed to exist: the firmware
   * generator reads it to turn a valueless `#define` into a real one, and
   * only a human stating a pin here can do that — the generator itself never
   * invents one. Replaces the old unnamed/untyped `pinMap` field, which
   * nothing in the codebase ever wrote (verified by grep) and is deleted
   * rather than kept for compatibility.
   */
  pinAssignments: z.record(z.string(), z.object({ from: z.string().min(1).optional(), to: z.string().min(1).optional() })).optional(),
});
export type ConnectionAttrs = z.infer<typeof ConnectionAttrs>;

export const Connection = z.object({
  id: z.string(),
  projectId: z.string(),
  fromBlockId: z.string(),
  fromPort: z.string().default(""),
  toBlockId: z.string(),
  toPort: z.string().default(""),
  interface: InterfaceKind,
  attrs: ConnectionAttrs.default({}),
});
export type Connection = z.infer<typeof Connection>;

export const CreateConnectionInput = Connection.pick({
  fromBlockId: true,
  toBlockId: true,
  interface: true,
}).extend({
  fromPort: z.string().optional(),
  toPort: z.string().optional(),
  attrs: ConnectionAttrs.optional(),
});
export type CreateConnectionInput = z.infer<typeof CreateConnectionInput>;

export const UpdateConnectionInput = CreateConnectionInput.partial();
export type UpdateConnectionInput = z.infer<typeof UpdateConnectionInput>;
