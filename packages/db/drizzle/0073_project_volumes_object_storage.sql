ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "volumes" jsonb;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "object_storage" jsonb;
