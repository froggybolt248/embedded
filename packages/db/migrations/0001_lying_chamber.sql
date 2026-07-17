CREATE TABLE `archetypes` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`recipe` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `blocks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`role` text DEFAULT 'other' NOT NULL,
	`component_id` text,
	`notes` text DEFAULT '' NOT NULL,
	`x` real DEFAULT 0 NOT NULL,
	`y` real DEFAULT 0 NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`component_id`) REFERENCES `components`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `calculator_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`calculator_id` text NOT NULL,
	`project_id` text,
	`inputs` text DEFAULT '{}' NOT NULL,
	`outputs` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`calculator_id`) REFERENCES `calculators`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `calculators` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`inputs` text DEFAULT '[]' NOT NULL,
	`formula` text DEFAULT '{}' NOT NULL,
	`outputs` text DEFAULT '[]' NOT NULL,
	`citation` text,
	`builtin` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `components` (
	`id` text PRIMARY KEY NOT NULL,
	`mpn` text NOT NULL,
	`manufacturer` text DEFAULT '' NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`category` text DEFAULT 'other' NOT NULL,
	`lifecycle` text DEFAULT 'unknown' NOT NULL,
	`specs` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `connections` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_block_id` text NOT NULL,
	`from_port` text DEFAULT '' NOT NULL,
	`to_block_id` text NOT NULL,
	`to_port` text DEFAULT '' NOT NULL,
	`interface` text NOT NULL,
	`attrs` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_block_id`) REFERENCES `blocks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `datasheets` (
	`id` text PRIMARY KEY NOT NULL,
	`component_id` text,
	`filename` text NOT NULL,
	`file_path` text NOT NULL,
	`sha256` text NOT NULL,
	`page_count` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`component_id`) REFERENCES `components`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `design_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`severity` text DEFAULT 'warning' NOT NULL,
	`applies_to` text DEFAULT '{}' NOT NULL,
	`check` text NOT NULL,
	`citation` text,
	`enabled` integer DEFAULT true NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `extraction_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`datasheet_id` text NOT NULL,
	`model` text NOT NULL,
	`prompt_version` text NOT NULL,
	`status` text NOT NULL,
	`section_map` text DEFAULT '{}' NOT NULL,
	`fields` text DEFAULT '{}' NOT NULL,
	`error` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`datasheet_id`) REFERENCES `datasheets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `firmware_artifacts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`filename` text NOT NULL,
	`content` text NOT NULL,
	`generated_from` text DEFAULT '{}' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text DEFAULT 'functional' NOT NULL,
	`text` text NOT NULL,
	`quantified` text,
	`status` text DEFAULT 'open' NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
