ALTER TABLE "action_workflow" ADD COLUMN IF NOT EXISTS "controller" text NOT NULL DEFAULT 'openship';
--> statement-breakpoint
ALTER TABLE "action_workflow" ADD COLUMN IF NOT EXISTS "github_workflow_id" text;
--> statement-breakpoint
ALTER TABLE "action_workflow" ADD COLUMN IF NOT EXISTS "sync_after" timestamp NOT NULL DEFAULT now();
--> statement-breakpoint
ALTER TABLE "action_workflow" ADD COLUMN IF NOT EXISTS "sync_lease_owner" text;
--> statement-breakpoint
ALTER TABLE "action_workflow" ADD COLUMN IF NOT EXISTS "sync_lease_until" timestamp;
--> statement-breakpoint
ALTER TABLE "action_workflow" ADD CONSTRAINT "action_workflow_controller_check" CHECK ("controller" IN ('openship', 'github'));
--> statement-breakpoint
ALTER TABLE "action_workflow" ADD CONSTRAINT "action_workflow_github_check" CHECK ("controller" <> 'github' OR ("owner" IS NOT NULL AND "repo" IS NOT NULL AND "source" IS NULL AND "github_workflow_id" IS NOT NULL));
--> statement-breakpoint
CREATE INDEX "action_workflow_sync_idx" ON "action_workflow" ("controller", "sync_after", "sync_lease_until");
--> statement-breakpoint
ALTER TABLE "action_run" ADD COLUMN IF NOT EXISTS "controller" text NOT NULL DEFAULT 'openship';
--> statement-breakpoint
ALTER TABLE "action_run" ADD COLUMN IF NOT EXISTS "github" jsonb;
--> statement-breakpoint
ALTER TABLE "action_run" ADD CONSTRAINT "action_run_controller_check" CHECK ("controller" IN ('openship', 'github'));
--> statement-breakpoint
CREATE UNIQUE INDEX "action_run_github_unique" ON "action_run" ("organization_id", ("github"->>'id'), "attempt");
--> statement-breakpoint
ALTER TABLE "action_job" ADD COLUMN IF NOT EXISTS "github" jsonb;

--> statement-breakpoint
DROP INDEX "action_run_number_attempt_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "action_run_number_attempt_unique" ON "action_run" ("workflow_id", "controller", "number", "attempt");
