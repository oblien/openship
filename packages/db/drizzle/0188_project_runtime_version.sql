ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "runtime_version" text;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "runtime_image" text;
