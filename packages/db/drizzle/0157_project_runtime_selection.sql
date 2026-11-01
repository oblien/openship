ALTER TABLE "cloud_workspace" DROP CONSTRAINT IF EXISTS "cloud_workspace_runtime_check";
--> statement-breakpoint
ALTER TABLE "cloud_workspace" DROP CONSTRAINT IF EXISTS "cloud_workspace_mode_check";
--> statement-breakpoint
ALTER TABLE "cloud_workspace" DROP COLUMN IF EXISTS "runtime";
--> statement-breakpoint
ALTER TABLE "cloud_workspace" DROP COLUMN IF EXISTS "mode";

--> statement-breakpoint
ALTER TABLE "cloud_docker_workspace" DROP CONSTRAINT IF EXISTS "cloud_docker_workspace_owner_check";
--> statement-breakpoint
ALTER TABLE "cloud_docker_workspace" DROP COLUMN IF EXISTS "project_id";
--> statement-breakpoint
ALTER TABLE "cloud_docker_workspace" ALTER COLUMN "owner_workspace_id" SET NOT NULL;

--> statement-breakpoint
ALTER TABLE "project" DROP COLUMN IF EXISTS "cloud_workspace_id";
--> statement-breakpoint
ALTER TABLE "project" DROP COLUMN IF EXISTS "cloud_archive_strategy";
