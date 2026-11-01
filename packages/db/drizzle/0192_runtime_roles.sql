-- Runtime roles (#935): extra processes (workers, a scheduler) declared per
-- project and the container-per-role-replica map recorded on each deployment.
-- Both are nullable with no default, so every existing row keeps its behaviour.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "roles" jsonb;
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "role_containers" jsonb;
