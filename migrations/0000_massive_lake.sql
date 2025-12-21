CREATE TABLE `alert` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(50) NOT NULL,
	`conditions` json NOT NULL,
	`timeframe` varchar(10) NOT NULL DEFAULT '1h',
	`status` varchar(20) NOT NULL DEFAULT 'active',
	`created_at` timestamp DEFAULT (now()),
	`note` varchar(255),
	`last_alert_at` bigint DEFAULT 0,
	CONSTRAINT `alert_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `cool_down` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(15),
	`last_trade_at` bigint NOT NULL,
	CONSTRAINT `cool_down_id` PRIMARY KEY(`id`),
	CONSTRAINT `cool_down_symbol_unique` UNIQUE(`symbol`)
);
--> statement-breakpoint
CREATE TABLE `heartbeat` (
	`id` int NOT NULL,
	`cycle_count` int NOT NULL DEFAULT 0,
	`last_heartbeat_at` bigint NOT NULL DEFAULT 0,
	CONSTRAINT `heartbeat_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `locks` (
	`id` int NOT NULL,
	`is_locked` boolean NOT NULL DEFAULT false,
	CONSTRAINT `locks_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` varchar(255) NOT NULL,
	`user_id` varchar(255) NOT NULL,
	`expires_at` timestamp NOT NULL,
	CONSTRAINT `session_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `simulated_trades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`signal_id` varchar(36) NOT NULL,
	`symbol` varchar(50) NOT NULL,
	`side` varchar(10) NOT NULL,
	`entry_price` float NOT NULL,
	`stop_loss` float,
	`trailing_dist` float,
	`tp_levels` json,
	`opened_at` bigint NOT NULL,
	`closed_at` bigint,
	`outcome` varchar(15),
	`pnl` bigint NOT NULL,
	`r_multiple` bigint,
	`label` int,
	`mfe` bigint,
	`mae` bigint,
	`duration_ms` bigint DEFAULT 0,
	CONSTRAINT `simulated_trades_id` PRIMARY KEY(`id`),
	CONSTRAINT `simulated_trades_signal_id_unique` UNIQUE(`signal_id`)
);
--> statement-breakpoint
CREATE TABLE `symbol_history` (
	`symbol` varchar(50) NOT NULL,
	`history_json` json NOT NULL DEFAULT ('[]'),
	`avg_r` float NOT NULL DEFAULT 0,
	`win_rate` float NOT NULL DEFAULT 0,
	`reverse_count` int NOT NULL DEFAULT 0,
	`avg_mae` float NOT NULL DEFAULT 0,
	`avg_mfe` float NOT NULL DEFAULT 0,
	`avg_excursion_ratio` float NOT NULL DEFAULT 0,
	`recent_mfe` float NOT NULL DEFAULT 0,
	`recent_mae` float NOT NULL DEFAULT 0,
	`recent_sample_count` int NOT NULL DEFAULT 0,
	`avg_mfe_long` float NOT NULL DEFAULT 0,
	`avg_mae_long` float NOT NULL DEFAULT 0,
	`avg_mfe_short` float NOT NULL DEFAULT 0,
	`avg_mae_short` float NOT NULL DEFAULT 0,
	`win_rate_long` float NOT NULL DEFAULT 0,
	`win_rate_short` float NOT NULL DEFAULT 0,
	`recent_reverse_count_long` int NOT NULL DEFAULT 0,
	`recent_reverse_count_short` int NOT NULL DEFAULT 0,
	`recent_reverse_count` int NOT NULL DEFAULT 0,
	`updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `symbol_history_symbol` PRIMARY KEY(`symbol`)
);
--> statement-breakpoint
CREATE TABLE `trades` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(50) NOT NULL,
	`side` varchar(10) NOT NULL,
	`amount` float NOT NULL,
	`price` float NOT NULL,
	`timestamp` bigint NOT NULL,
	`mode` varchar(10) NOT NULL,
	`order_id` varchar(50) NOT NULL,
	CONSTRAINT `trades_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `training_samples` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(50) NOT NULL,
	`features` json NOT NULL,
	`label` int NOT NULL,
	`created_at` timestamp DEFAULT (now()),
	CONSTRAINT `training_samples_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `user` (
	`id` varchar(255) NOT NULL,
	`age` int,
	`username` varchar(50) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	CONSTRAINT `user_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_username_unique` UNIQUE(`username`)
);
--> statement-breakpoint
ALTER TABLE `session` ADD CONSTRAINT `session_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_sim_signal_id` ON `simulated_trades` (`signal_id`);--> statement-breakpoint
CREATE INDEX `idx_sim_symbol` ON `simulated_trades` (`symbol`);--> statement-breakpoint
CREATE INDEX `idx_sim_opened` ON `simulated_trades` (`opened_at`);--> statement-breakpoint
CREATE INDEX `idx_sim_outcome` ON `simulated_trades` (`outcome`);--> statement-breakpoint
CREATE INDEX `idx_sim_label` ON `simulated_trades` (`label`);--> statement-breakpoint
CREATE INDEX `idx_sim_closed` ON `simulated_trades` (`closed_at`);--> statement-breakpoint
CREATE INDEX `idx_sim_duration` ON `simulated_trades` (`duration_ms`);--> statement-breakpoint
CREATE INDEX `idx_symbol_history_symbol` ON `symbol_history` (`symbol`);--> statement-breakpoint
CREATE INDEX `idx_symbol_history_excursions` ON `symbol_history` (`avg_mae`,`avg_mfe`);--> statement-breakpoint
CREATE INDEX `idx_symbol_history_recent` ON `symbol_history` (`updated_at`);--> statement-breakpoint
CREATE INDEX `idx_trades_symbol` ON `trades` (`symbol`);--> statement-breakpoint
CREATE INDEX `idx_trades_timestamp` ON `trades` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_training_symbol` ON `training_samples` (`symbol`);--> statement-breakpoint
CREATE INDEX `idx_training_label` ON `training_samples` (`label`);--> statement-breakpoint
CREATE INDEX `idx_training_created` ON `training_samples` (`created_at`);