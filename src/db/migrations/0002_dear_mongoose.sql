CREATE TABLE `role_panels` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`style` text DEFAULT 'buttons' NOT NULL,
	`mode` text DEFAULT 'multi' NOT NULL,
	`options` text DEFAULT '[]' NOT NULL,
	`channel_id` text,
	`message_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `role_panels_guild` ON `role_panels` (`guild_id`);