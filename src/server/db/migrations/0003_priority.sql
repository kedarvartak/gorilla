ALTER TABLE `cards` ADD `priority` text DEFAULT 'normal' NOT NULL;--> statement-breakpoint
CREATE INDEX `cards_priority` ON `cards` (`priority`);