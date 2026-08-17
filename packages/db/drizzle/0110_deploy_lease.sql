ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "deploy_lease_id" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "release_phase" text;
