ALTER TABLE `boards` ADD `policy_repair_attempts` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `cards` ADD `completion_report` text;--> statement-breakpoint
ALTER TABLE `cards` ADD `repairs` integer DEFAULT 0 NOT NULL;