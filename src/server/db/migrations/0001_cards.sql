CREATE TABLE `card_dependencies` (
	`card_id` text NOT NULL,
	`depends_on_card_id` text NOT NULL,
	FOREIGN KEY (`card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_card_id`) REFERENCES `cards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `card_dependencies_pair` ON `card_dependencies` (`card_id`,`depends_on_card_id`);--> statement-breakpoint
CREATE INDEX `card_dependencies_depends_on` ON `card_dependencies` (`depends_on_card_id`);--> statement-breakpoint
CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`column_id` text NOT NULL,
	`plan_id` text,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`position` integer NOT NULL,
	`goal_condition` text,
	`guardrails` text DEFAULT '{}' NOT NULL,
	`agent_model` text,
	`agent_effort` text,
	`permission_mode` text,
	`synthesis_model` text,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_seen_at` integer,
	`acknowledged_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`column_id`) REFERENCES `columns`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`plan_id`) REFERENCES `plans`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `cards_board` ON `cards` (`board_id`);--> statement-breakpoint
CREATE INDEX `cards_column_position` ON `cards` (`column_id`,`position`);--> statement-breakpoint
CREATE INDEX `cards_status` ON `cards` (`status`);--> statement-breakpoint
CREATE INDEX `cards_plan` ON `cards` (`plan_id`);--> statement-breakpoint
CREATE TABLE `columns` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`is_ready` integer DEFAULT false NOT NULL,
	`is_review_gate` integer DEFAULT false NOT NULL,
	`is_terminal` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `columns_board_position` ON `columns` (`board_id`,`position`);--> statement-breakpoint
CREATE INDEX `columns_board` ON `columns` (`board_id`);--> statement-breakpoint
CREATE TABLE `plans` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`source_session_id` text,
	`prompt` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `plans_board` ON `plans` (`board_id`);