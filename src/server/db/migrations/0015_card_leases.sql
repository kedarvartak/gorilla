CREATE TABLE `card_leases` (
	`card_id` text PRIMARY KEY NOT NULL,
	`acquired_at` integer NOT NULL,
	`owner` text NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
