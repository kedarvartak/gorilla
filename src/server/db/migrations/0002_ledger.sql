CREATE TABLE `extraction_cursors` (
	`run_id` text PRIMARY KEY NOT NULL,
	`through_seq` integer DEFAULT 0 NOT NULL,
	`tokens_spent` integer DEFAULT 0 NOT NULL,
	`last_outcome` text,
	`last_note` text,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `ledger_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`run_id` text NOT NULL,
	`kind` text NOT NULL,
	`statement` text NOT NULL,
	`detail` text,
	`alternative` text,
	`file_paths` text DEFAULT '[]' NOT NULL,
	`source_event_ids` text DEFAULT '[]' NOT NULL,
	`origin` text DEFAULT 'model' NOT NULL,
	`confidence` integer,
	`model` text,
	`superseded_by` text,
	`operator_status` text DEFAULT 'unreviewed' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ledger_card` ON `ledger_entries` (`card_id`);--> statement-breakpoint
CREATE INDEX `ledger_run` ON `ledger_entries` (`run_id`);--> statement-breakpoint
CREATE INDEX `ledger_card_created` ON `ledger_entries` (`card_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ledger_kind` ON `ledger_entries` (`kind`);