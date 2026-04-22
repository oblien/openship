ALTER TABLE "webhook_events" RENAME TO "deploy_triggers";
--> statement-breakpoint
ALTER TABLE "deploy_triggers" ADD COLUMN IF NOT EXISTS "project_id" text;
--> statement-breakpoint
ALTER TABLE "deploy_triggers" ADD COLUMN IF NOT EXISTS "branch" text;
--> statement-breakpoint
ALTER TABLE "deploy_triggers" ADD COLUMN IF NOT EXISTS "commit_sha" text;
--> statement-breakpoint
ALTER TABLE "deploy_triggers" ADD COLUMN IF NOT EXISTS "commit_message" text;
--> statement-breakpoint
ALTER TABLE "deploy_triggers" ADD COLUMN IF NOT EXISTS "delivery_id" text;
--> statement-breakpoint
ALTER TABLE "deploy_triggers" ALTER COLUMN "payload" DROP NOT NULL;
--> statement-breakpoint
UPDATE "deploy_triggers"
SET
	"branch" = COALESCE("branch", regexp_replace(COALESCE("payload"->>'ref', ''), '^refs/heads/', '')),
	"commit_sha" = COALESCE("commit_sha", "payload"->'head_commit'->>'id'),
	"commit_message" = COALESCE("commit_message", "payload"->'head_commit'->>'message')
WHERE "payload" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_deploy_triggers_project_delivery" ON "deploy_triggers" ("project_id", "delivery_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deploy_triggers_pending" ON "deploy_triggers" ("user_id", "delivered_at", "created_at");