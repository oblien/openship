-- Azure DevOps import: 3-level org/project/repo + instance PAT + Service Hook id.
--
-- git_project is the Azure "project" (middle segment). Null on GitHub rows.
-- webhook_external_id holds Azure Service Hook subscription GUIDs; GitHub
-- continues to use integer webhook_id.
-- azure_pat_encrypted is the instance-wide PAT (self-hosted), sealed the same
-- way as gh_device_token_encrypted. Never stored inside git_url.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "git_project" text;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "webhook_external_id" text;
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "azure_pat_encrypted" text;
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "azure_pat_set_at" timestamp;
