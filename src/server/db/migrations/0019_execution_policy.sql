ALTER TABLE `boards` ADD `policy_provider` text DEFAULT 'claude' NOT NULL;--> statement-breakpoint
ALTER TABLE `boards` ADD `policy_model` text;--> statement-breakpoint
ALTER TABLE `boards` ADD `policy_effort` text;--> statement-breakpoint
ALTER TABLE `boards` ADD `policy_permission_mode` text;--> statement-breakpoint
ALTER TABLE `boards` ADD `policy_verify` text;--> statement-breakpoint
ALTER TABLE `boards` ADD `policy_setup` text;--> statement-breakpoint
ALTER TABLE `boards` ADD `policy_token_ceiling` integer;
