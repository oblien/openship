ALTER TABLE "cloud_workspace" ADD COLUMN "activity" jsonb;
--> statement-breakpoint
DROP INDEX "cloud_workspace_remote_unique";
--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_workspace_remote_unique" ON "cloud_workspace" (("remote"->>'apiUrl'), ("remote"->>'organizationId'), ("remote"->>'serverId'));
--> statement-breakpoint
CREATE TABLE "cloud_server_deletion" (
  "server_id" text PRIMARY KEY NOT NULL,
  "workspace_id" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "operation_id" text NOT NULL,
  "deleted_at" timestamp DEFAULT now() NOT NULL
);
