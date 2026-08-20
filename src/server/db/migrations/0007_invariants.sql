CREATE TABLE `invariants` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`statement` text NOT NULL,
	`source_card_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `invariants_board` ON `invariants` (`board_id`);