ALTER TABLE `components` ADD `family_id` text REFERENCES components(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `components` ADD `is_family` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `components` ADD `ordering_code` text;--> statement-breakpoint
ALTER TABLE `components` ADD `variant_attrs` text DEFAULT '{}' NOT NULL;