CREATE TABLE `clinic_users` (
	`id` int AUTO_INCREMENT NOT NULL,
	`username` varchar(64) NOT NULL,
	`passwordHash` varchar(255) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `clinic_users_id` PRIMARY KEY(`id`),
	CONSTRAINT `clinic_users_username_unique` UNIQUE(`username`)
);
