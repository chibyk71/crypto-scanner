CREATE TABLE `heartbeat` (
	`id` int NOT NULL,
	`cycleCount` int NOT NULL DEFAULT 0,
	`lastHeartbeatAt` bigint,
	CONSTRAINT `heartbeat_id` PRIMARY KEY(`id`)
);
