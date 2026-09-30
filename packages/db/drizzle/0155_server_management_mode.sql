ALTER TABLE "servers" ADD COLUMN "management_mode" text DEFAULT 'managed' NOT NULL;
--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_management_mode_check" CHECK ("management_mode" IN ('managed', 'observe_only'));
