CREATE TABLE `grounding_states` (
	`component_id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`detail` text,
	`error` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`component_id`) REFERENCES `components`(`id`) ON UPDATE no action ON DELETE cascade
);
