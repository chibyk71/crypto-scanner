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

CREATE TABLE `cool_down` (
	`id` int AUTO_INCREMENT NOT NULL,
	`symbol` varchar(15),
	`last_trade_at` bigint NOT NULL,
	CONSTRAINT `cool_down_id` PRIMARY KEY(`id`),
	CONSTRAINT `cool_down_symbol_unique` UNIQUE(`symbol`)
);

CREATE TABLE `heartbeat` (
	`id` int NOT NULL,
	`cycle_count` int NOT NULL DEFAULT 0,
	`last_heartbeat_at` bigint NOT NULL DEFAULT 0,
	CONSTRAINT `heartbeat_id` PRIMARY KEY(`id`)
);

CREATE TABLE `locks` (
	`id` int NOT NULL,
	`is_locked` boolean NOT NULL DEFAULT false,
	CONSTRAINT `locks_id` PRIMARY KEY(`id`)
);

CREATE TABLE `ohlcv_history` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`symbol` varchar(30) NOT NULL,
	`timeframe` varchar(10) NOT NULL,
	`timestamp` bigint NOT NULL,
	`open` decimal(30,10) NOT NULL,
	`high` decimal(30,10) NOT NULL,
	`low` decimal(30,10) NOT NULL,
	`close` decimal(30,10) NOT NULL,
	`volume` decimal(30,8) NOT NULL,
	CONSTRAINT `ohlcv_history_id` PRIMARY KEY(`id`),
	CONSTRAINT `unique_candle` UNIQUE(`symbol`,`timeframe`,`timestamp`)
);

CREATE TABLE `session` (
	`id` varchar(255) NOT NULL,
	`user_id` varchar(255) NOT NULL,
	`expires_at` timestamp NOT NULL,
	CONSTRAINT `session_id` PRIMARY KEY(`id`)
);

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
	`mfe` bigint DEFAULT 0,
	`mae` bigint DEFAULT 0,
	`duration_ms` bigint DEFAULT 0,
	`time_to_mfe_ms` bigint DEFAULT 0,
	`time_to_mae_ms` bigint DEFAULT 0,
	`features` json,
	CONSTRAINT `simulated_trades_id` PRIMARY KEY(`id`),
	CONSTRAINT `simulated_trades_signal_id_unique` UNIQUE(`signal_id`)
);

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

CREATE TABLE `user` (
	`id` varchar(255) NOT NULL,
	`age` int,
	`username` varchar(50) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	CONSTRAINT `user_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_username_unique` UNIQUE(`username`)
);

ALTER TABLE `session` ADD CONSTRAINT `session_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;
CREATE INDEX `idx_symbol_time` ON `ohlcv_history` (`symbol`,`timeframe`,`timestamp`);
CREATE INDEX `idx_sim_signal_id` ON `simulated_trades` (`signal_id`);
CREATE INDEX `idx_sim_symbol` ON `simulated_trades` (`symbol`);
CREATE INDEX `idx_sim_opened` ON `simulated_trades` (`opened_at`);
CREATE INDEX `idx_sim_outcome` ON `simulated_trades` (`outcome`);
CREATE INDEX `idx_sim_label` ON `simulated_trades` (`symbol`,`label`);
CREATE INDEX `idx_sim_closed` ON `simulated_trades` (`closed_at`);
CREATE INDEX `idx_sim_duration` ON `simulated_trades` (`duration_ms`);
CREATE INDEX `idx_trades_symbol` ON `trades` (`symbol`);
CREATE INDEX `idx_trades_timestamp` ON `trades` (`timestamp`);
