CREATE TABLE `submitted_tickets` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`card_id` integer NOT NULL,
	`ticket_no` text,
	`title` text NOT NULL,
	`submitter` text,
	`state` text NOT NULL,
	`resolution` text,
	`created_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `submitted_tickets_card` ON `submitted_tickets` (`guild_id`,`card_id`);--> statement-breakpoint
CREATE INDEX `submitted_tickets_open` ON `submitted_tickets` (`guild_id`,`closed_at`);