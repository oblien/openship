ALTER TABLE "action_workflow" ADD COLUMN IF NOT EXISTS "access_policy" jsonb;
--> statement-breakpoint
ALTER TABLE "action_run" ADD COLUMN IF NOT EXISTS "approval_key" text;
--> statement-breakpoint
ALTER TABLE "action_run" ADD COLUMN IF NOT EXISTS "admission" jsonb;
--> statement-breakpoint
ALTER TABLE "action_runner_session" ADD COLUMN IF NOT EXISTS "admitted_job_id" text;
--> statement-breakpoint
ALTER TABLE "action_runner_session" ADD COLUMN IF NOT EXISTS "admission_id" text;
