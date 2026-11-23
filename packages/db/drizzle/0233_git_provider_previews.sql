ALTER TABLE "pull_request_preview" ADD COLUMN "provider" text DEFAULT 'github' NOT NULL;
--> statement-breakpoint
DROP INDEX "pull_request_preview_source_repository_number";
--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_preview_source_repository_number" ON "pull_request_preview" ("source_project_id", "provider", "owner", "repo", "number");
--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "webhook_id" TYPE text USING "webhook_id"::text;
--> statement-breakpoint
ALTER TABLE "deployment_check_run" ALTER COLUMN "check_run_id" TYPE text USING "check_run_id"::text;
--> statement-breakpoint
ALTER TABLE "cloud_webhook_binding" ADD COLUMN "git_provider" text DEFAULT 'github' NOT NULL;
--> statement-breakpoint
ALTER TABLE "cloud_webhook_binding" ALTER COLUMN "webhook_id" TYPE text USING "webhook_id"::text;
--> statement-breakpoint
DROP INDEX "uq_cloud_webhook_binding_repo_branch";
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cloud_webhook_binding_repo_branch" ON "cloud_webhook_binding" ("organization_id", "git_provider", "git_owner", "git_repo", "git_branch");
--> statement-breakpoint
ALTER TABLE "action_workflow" ADD COLUMN "git_provider" text DEFAULT 'github' NOT NULL;
