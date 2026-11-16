CREATE TABLE `activity_daily` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`date` text NOT NULL,
	`message_points` real DEFAULT 0 NOT NULL,
	`voice_minutes` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`, `date`)
);
--> statement-breakpoint
CREATE INDEX `activity_daily_guild_date` ON `activity_daily` (`guild_id`,`date`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`source` text NOT NULL,
	`action` text NOT NULL,
	`target` text,
	`before` text,
	`after` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_log_guild_created` ON `audit_log` (`guild_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `bot_state` (
	`guild_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `guild_settings` (
	`guild_id` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`type` text NOT NULL,
	`event` text NOT NULL,
	`actor_id` text,
	`target_id` text,
	`channel_id` text,
	`summary` text NOT NULL,
	`data` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `logs_guild_type_created` ON `logs` (`guild_id`,`type`,`created_at`);--> statement-breakpoint
CREATE INDEX `logs_guild_actor` ON `logs` (`guild_id`,`actor_id`);--> statement-breakpoint
CREATE INDEX `logs_guild_target` ON `logs` (`guild_id`,`target_id`);--> statement-breakpoint
CREATE INDEX `logs_created` ON `logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `member_tier_state` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`tier_id` integer NOT NULL,
	`below_since` integer,
	PRIMARY KEY(`guild_id`, `user_id`, `tier_id`),
	FOREIGN KEY (`tier_id`) REFERENCES `tiers`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `members` (
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`username` text NOT NULL,
	`display_name` text NOT NULL,
	`avatar` text,
	`is_bot` integer DEFAULT false NOT NULL,
	`first_joined_at` integer NOT NULL,
	`joined_at` integer NOT NULL,
	`left_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`guild_id`, `user_id`)
);
--> statement-breakpoint
CREATE INDEX `members_guild_display` ON `members` (`guild_id`,`display_name`);--> statement-breakpoint
CREATE TABLE `mod_cases` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`case_number` integer NOT NULL,
	`action` text NOT NULL,
	`target_id` text NOT NULL,
	`moderator_id` text NOT NULL,
	`reason` text,
	`duration_ms` integer,
	`expires_at` integer,
	`source` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`data` text,
	`log_message_id` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `mod_cases_guild_number` ON `mod_cases` (`guild_id`,`case_number`);--> statement-breakpoint
CREATE INDEX `mod_cases_guild_target` ON `mod_cases` (`guild_id`,`target_id`);--> statement-breakpoint
CREATE INDEX `mod_cases_guild_created` ON `mod_cases` (`guild_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `permission_rules` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`role_id` text NOT NULL,
	`node` text NOT NULL,
	`allow` integer NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `permission_rules_guild_role_node` ON `permission_rules` (`guild_id`,`role_id`,`node`);--> statement-breakpoint
CREATE TABLE `scheduled_actions` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`kind` text NOT NULL,
	`target_id` text NOT NULL,
	`case_id` integer,
	`run_at` integer NOT NULL,
	`done_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	FOREIGN KEY (`case_id`) REFERENCES `mod_cases`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `scheduled_actions_due` ON `scheduled_actions` (`done_at`,`run_at`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id_hash` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`user_id` text NOT NULL,
	`csrf_token` text NOT NULL,
	`user` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `sessions_expires` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `temp_channels` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`hub_channel_id` text NOT NULL,
	`owner_id` text,
	`occupants` text DEFAULT '[]' NOT NULL,
	`rename_timestamps` text DEFAULT '[]' NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `temp_channels_guild` ON `temp_channels` (`guild_id`);--> statement-breakpoint
CREATE TABLE `tiers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`guild_id` text NOT NULL,
	`name` text NOT NULL,
	`role_id` text NOT NULL,
	`min_tenure_days` integer DEFAULT 0 NOT NULL,
	`min_activity` real DEFAULT 0 NOT NULL,
	`position` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tiers_guild_role` ON `tiers` (`guild_id`,`role_id`);--> statement-breakpoint
CREATE INDEX `tiers_guild_position` ON `tiers` (`guild_id`,`position`);--> statement-breakpoint
CREATE TABLE `voice_hubs` (
	`channel_id` text PRIMARY KEY NOT NULL,
	`guild_id` text NOT NULL,
	`type` text NOT NULL,
	`category_id` text NOT NULL,
	`name_template` text DEFAULT '{user}''s Channel' NOT NULL,
	`default_limit` integer DEFAULT 0 NOT NULL,
	`hide_from_everyone` integer DEFAULT false NOT NULL,
	`created_at` integer DEFAULT (unixepoch('subsec') * 1000) NOT NULL
);
