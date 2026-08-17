-- Cancel frees uq_deployment_one_active_per_project immediately. The lease is
-- the execution lock: it stays held until the worker acknowledges and host
-- leftovers (builder, .incoming-*, .auth-*) are aborted.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "deploy_lease_id" text;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "release_phase" text;
