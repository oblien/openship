ALTER TABLE "service_incident" ADD COLUMN IF NOT EXISTS "deployment_id" text;
--> statement-breakpoint
ALTER TABLE "service_incident" ADD COLUMN IF NOT EXISTS "tracked_container_id" text;
