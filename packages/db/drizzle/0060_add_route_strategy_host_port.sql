ALTER TABLE "project" ADD COLUMN "host_port" integer;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "route_strategy" text DEFAULT 'auto';--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "route_strategy" text DEFAULT 'auto' NOT NULL;