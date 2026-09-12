ALTER TABLE `cards` ADD `integrated_at` integer;--> statement-breakpoint
ALTER TABLE `plans` ADD `approved_at` integer;--> statement-breakpoint
ALTER TABLE `plans` ADD `integration_branch` text;--> statement-breakpoint
ALTER TABLE `plans` ADD `merged_at` integer;--> statement-breakpoint
ALTER TABLE `plans` ADD `merged_into` text;