ALTER TABLE "cloud_workspace" ADD COLUMN "remote" jsonb;
--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_workspace_remote_unique" ON "cloud_workspace" ("organization_id", "remote");
