import {
  sqliteTable,
  text,
  integer,
  real,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";

/**
 * Full M1 domain model. JSON columns are validated with Zod schemas from
 * @embedded/core at the repository boundary.
 */
export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  archetypeId: text("archetype_id"),
  phaseStates: text("phase_states", { mode: "json" }).notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const components = sqliteTable("components", {
  id: text("id").primaryKey(),
  mpn: text("mpn").notNull(),
  manufacturer: text("manufacturer").notNull().default(""),
  description: text("description").notNull().default(""),
  category: text("category").notNull().default("other"),
  lifecycle: text("lifecycle").notNull().default("unknown"),
  specs: text("specs", { mode: "json" }).notNull().default("{}"),
  familyId: text("family_id").references((): AnySQLiteColumn => components.id, {
    onDelete: "set null",
  }),
  isFamily: integer("is_family", { mode: "boolean" }).notNull().default(false),
  orderingCode: text("ordering_code"),
  variantAttrs: text("variant_attrs", { mode: "json" }).notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const datasheets = sqliteTable("datasheets", {
  id: text("id").primaryKey(),
  componentId: text("component_id").references(() => components.id, { onDelete: "set null" }),
  filename: text("filename").notNull(),
  filePath: text("file_path").notNull(),
  sha256: text("sha256").notNull(),
  pageCount: integer("page_count").notNull(),
  createdAt: text("created_at").notNull(),
});

export const extractionRuns = sqliteTable("extraction_runs", {
  id: text("id").primaryKey(),
  datasheetId: text("datasheet_id")
    .notNull()
    .references(() => datasheets.id, { onDelete: "cascade" }),
  model: text("model").notNull(),
  promptVersion: text("prompt_version").notNull(),
  status: text("status").notNull(),
  sectionMap: text("section_map", { mode: "json" }).notNull().default("{}"),
  fields: text("fields", { mode: "json" }).notNull().default("{}"),
  error: text("error"),
  createdAt: text("created_at").notNull(),
});

export const requirements = sqliteTable("requirements", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().default("functional"),
  text: text("text").notNull(),
  quantified: text("quantified", { mode: "json" }),
  status: text("status").notNull().default("open"),
  createdAt: text("created_at").notNull(),
});

export const blocks = sqliteTable("blocks", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  role: text("role").notNull().default("other"),
  componentId: text("component_id").references(() => components.id, { onDelete: "set null" }),
  notes: text("notes").notNull().default(""),
  x: real("x").notNull().default(0),
  y: real("y").notNull().default(0),
  duties: text("duties", { mode: "json" }).notNull().default("{}"),
});

export const connections = sqliteTable("connections", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  fromBlockId: text("from_block_id")
    .notNull()
    .references(() => blocks.id, { onDelete: "cascade" }),
  fromPort: text("from_port").notNull().default(""),
  toBlockId: text("to_block_id")
    .notNull()
    .references(() => blocks.id, { onDelete: "cascade" }),
  toPort: text("to_port").notNull().default(""),
  interface: text("interface").notNull(),
  attrs: text("attrs", { mode: "json" }).notNull().default("{}"),
});

export const designRules = sqliteTable("design_rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  severity: text("severity").notNull().default("warning"),
  appliesTo: text("applies_to", { mode: "json" }).notNull().default("{}"),
  check: text("check", { mode: "json" }).notNull(),
  citation: text("citation"),
  enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
  builtin: integer("builtin", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const calculators = sqliteTable("calculators", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  inputs: text("inputs", { mode: "json" }).notNull().default("[]"),
  formula: text("formula", { mode: "json" }).notNull().default("{}"),
  outputs: text("outputs", { mode: "json" }).notNull().default("[]"),
  citation: text("citation"),
  builtin: integer("builtin", { mode: "boolean" }).notNull().default(false),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const calculatorRuns = sqliteTable("calculator_runs", {
  id: text("id").primaryKey(),
  calculatorId: text("calculator_id")
    .notNull()
    .references(() => calculators.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  inputs: text("inputs", { mode: "json" }).notNull().default("{}"),
  outputs: text("outputs", { mode: "json" }).notNull().default("{}"),
  createdAt: text("created_at").notNull(),
});

export const archetypes = sqliteTable("archetypes", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  recipe: text("recipe", { mode: "json" }).notNull().default("{}"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const firmwareArtifacts = sqliteTable("firmware_artifacts", {
  id: text("id").primaryKey(),
  projectId: text("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  filename: text("filename").notNull(),
  content: text("content").notNull(),
  generatedFrom: text("generated_from", { mode: "json" }).notNull().default("{}"),
  createdAt: text("created_at").notNull(),
});
