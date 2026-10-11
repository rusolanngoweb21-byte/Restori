CREATE TABLE `threat_blocks` (
	`hash` text PRIMARY KEY NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `runtime_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cache_expiry_idx` ON `runtime_cache` (`expires_at`);--> statement-breakpoint
CREATE TABLE `analysis_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner` text NOT NULL,
	`detector` text NOT NULL,
	`version` text NOT NULL,
	`cache_key` text NOT NULL,
	`payload_key` text NOT NULL,
	`state` text NOT NULL,
	`outcome` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`lease` text,
	`lease_until` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX `jobs_claim_idx` ON `analysis_jobs` (`state`,`lease_until`,`created_at`);--> statement-breakpoint
CREATE INDEX `jobs_expiry_idx` ON `analysis_jobs` (`expires_at`);--> statement-breakpoint
CREATE INDEX `jobs_owner_cache_idx` ON `analysis_jobs` (`owner`,`cache_key`,`state`);--> statement-breakpoint
CREATE TABLE `rate_windows` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `rate_expiry_idx` ON `rate_windows` (`expires_at`);--> statement-breakpoint
CREATE TABLE `analysis_workers` (
	`id` text PRIMARY KEY NOT NULL,
	`capabilities` text NOT NULL,
	`expires_at` integer NOT NULL
);
