ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "auto_deploy_cancel_builds" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
DROP INDEX IF EXISTS "action_deployment_commit_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "action_deployment_commit_unique" ON "action_deployment" ("project_id", "revision") WHERE "intent"->>'kind' IS DISTINCT FROM 'push';
