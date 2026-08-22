CREATE TABLE `card_paths` (
	`card_id` text NOT NULL,
	`path` text NOT NULL,
	`source` text NOT NULL,
	`recorded_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_paths_unique` ON `card_paths` (`card_id`,`path`,`source`);--> statement-breakpoint
CREATE INDEX `card_paths_path` ON `card_paths` (`path`);