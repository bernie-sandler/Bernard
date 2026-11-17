CREATE TABLE `issue_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`reporter_id` text NOT NULL,
	`channel_id` text,
	`service` text NOT NULL,
	`monitor_id` integer,
	`details` text,
	`card_id` integer NOT NULL,
	`ticket_no` text,
	`card_status` text NOT NULL,
	`state` text DEFAULT 'received' NOT NULL,
	`resolution` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`closed_at` integer,
	`notified_via` text
);
--> statement-breakpoint
CREATE INDEX `issue_reports_open` ON `issue_reports` (`guild_id`,`closed_at`);--> statement-breakpoint
CREATE INDEX `issue_reports_reporter` ON `issue_reports` (`reporter_id`);