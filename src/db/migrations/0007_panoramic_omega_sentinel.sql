CREATE TABLE `crazy_penalties` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`poll_id` integer,
	`target_id` text NOT NULL,
	`action` text NOT NULL,
	`ends_at` integer NOT NULL,
	`applied_at` integer,
	`lifted_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`poll_id`) REFERENCES `crazy_polls`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `crazy_penalties_open` ON `crazy_penalties` (`guild_id`,`lifted_at`,`target_id`);--> statement-breakpoint
CREATE TABLE `crazy_polls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`target_id` text NOT NULL,
	`starter_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`message_id` text,
	`needed` integer NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`strike` integer,
	`expires_at` integer NOT NULL,
	`resolved_at` integer,
	`pardoned_at` integer,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `crazy_polls_target` ON `crazy_polls` (`guild_id`,`target_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `crazy_polls_status` ON `crazy_polls` (`guild_id`,`status`);--> statement-breakpoint
CREATE TABLE `crazy_votes` (
	`poll_id` integer NOT NULL,
	`voter_id` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	PRIMARY KEY(`poll_id`, `voter_id`),
	FOREIGN KEY (`poll_id`) REFERENCES `crazy_polls`(`id`) ON UPDATE no action ON DELETE cascade
);
