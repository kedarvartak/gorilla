ALTER TABLE `runs` ADD `input_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `output_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `cache_read_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `cache_creation_tokens` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `cost_usd` real;--> statement-breakpoint
ALTER TABLE `runs` ADD `turns` integer;--> statement-breakpoint
ALTER TABLE `runs` ADD `cost_source` text;