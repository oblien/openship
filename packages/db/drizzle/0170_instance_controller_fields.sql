-- Early development installs created these tables before the nullable fields were added.
-- Add them without replaying the table creation or changing controller authority.
ALTER TABLE "instance_controller" ADD COLUMN IF NOT EXISTS "environment" text;
--> statement-breakpoint
ALTER TABLE "instance_controller" ADD COLUMN IF NOT EXISTS "desktop_user_id" text;
--> statement-breakpoint
ALTER TABLE "instance_controller" ADD COLUMN IF NOT EXISTS "project_id" text;
--> statement-breakpoint
ALTER TABLE "instance_handoff" ADD COLUMN IF NOT EXISTS "recovery" jsonb;
--> statement-breakpoint
ALTER TABLE "instance_handoff" ADD COLUMN IF NOT EXISTS "provisioning" jsonb;
