-- Earlier workspace/advisory schemas can already be recorded as applied.
-- Repair their additive fields without replaying CREATE TABLE or changing data.
ALTER TABLE "cloud_workspace" ADD COLUMN IF NOT EXISTS "operation" jsonb;
--> statement-breakpoint
ALTER TABLE "cloud_workspace" ADD COLUMN IF NOT EXISTS "pending_checkouts" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_security" ADD COLUMN IF NOT EXISTS "evaluated_at" timestamp;
--> statement-breakpoint
ALTER TABLE "project_security" ADD COLUMN IF NOT EXISTS "feed_revision" bigint DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "security_refresh_attempt" ADD COLUMN IF NOT EXISTS "advisory_id" text;
--> statement-breakpoint
ALTER TABLE "security_refresh_attempt" ADD COLUMN IF NOT EXISTS "action_request_id" text;
--> statement-breakpoint
ALTER TABLE "security_refresh_attempt" ADD COLUMN IF NOT EXISTS "service_id" text;
--> statement-breakpoint
ALTER TABLE "security_refresh_attempt" ADD COLUMN IF NOT EXISTS "image" text;
