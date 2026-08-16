CREATE TABLE `boards` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`cwd` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `boards_cwd_unique` ON `boards` (`cwd`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` text NOT NULL,
	`session_id` text NOT NULL,
	`seq` integer NOT NULL,
	`event_name` text NOT NULL,
	`received_at` integer NOT NULL,
	`payload` text NOT NULL,
	`tool_name` text GENERATED ALWAYS AS (json_extract(payload, '$.tool_name')) VIRTUAL,
	`tool_use_id` text GENERATED ALWAYS AS (json_extract(payload, '$.tool_use_id')) VIRTUAL,
	`prompt_id` text GENERATED ALWAYS AS (json_extract(payload, '$.prompt_id')) VIRTUAL,
	`agent_id` text GENERATED ALWAYS AS (json_extract(payload, '$.agent_id')) VIRTUAL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `events_run_seq_unique` ON `events` (`run_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_session_seq` ON `events` (`session_id`,`seq`);--> statement-breakpoint
CREATE INDEX `events_name_received` ON `events` (`event_name`,`received_at`);--> statement-breakpoint
CREATE INDEX `events_tool_name` ON `events` (`tool_name`);--> statement-breakpoint
CREATE INDEX `events_tool_use_id` ON `events` (`tool_use_id`);--> statement-breakpoint
CREATE INDEX `events_prompt_id` ON `events` (`prompt_id`);--> statement-breakpoint
CREATE INDEX `events_agent_id` ON `events` (`agent_id`);--> statement-breakpoint
CREATE TABLE `runs` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`card_id` text,
	`session_id` text NOT NULL,
	`mode` text DEFAULT 'attached' NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer,
	`end_reason` text,
	`model` text,
	`permission_mode` text,
	`goal_outcome` text,
	`transcript_path` text,
	`cwd` text NOT NULL,
	`git_branch` text,
	`head_sha_at_start` text,
	`head_sha_at_end` text,
	`last_seq` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `runs_session_unique` ON `runs` (`session_id`);--> statement-breakpoint
CREATE INDEX `runs_board_started` ON `runs` (`board_id`,`started_at`);