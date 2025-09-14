CREATE TABLE `alert` (
	`id` int NOT NULL,
	`symbol` varchar(50) NOT NULL,
	`condition` varchar(50) NOT NULL,
	`target_price` double NOT NULL,
	`status` varchar(20) NOT NULL DEFAULT 'active',
	`created_at` timestamp DEFAULT (now()),
	`note` varchar(255),
	`last_alert_at` int,
	CONSTRAINT `alert_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `locks` (
	`id` int NOT NULL,
	`is_locked` boolean DEFAULT false,
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
CREATE TABLE `user` (
	`id` varchar(255) NOT NULL,
	`age` int,
	`username` varchar(50) NOT NULL,
	`password_hash` varchar(255) NOT NULL,
	CONSTRAINT `user_id` PRIMARY KEY(`id`),
	CONSTRAINT `user_username_unique` UNIQUE(`username`)
);
--> statement-breakpoint
ALTER TABLE `session` ADD CONSTRAINT `session_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE cascade ON UPDATE no action;