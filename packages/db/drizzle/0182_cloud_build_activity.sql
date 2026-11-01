CREATE TABLE "cloud_build_activity" (
  "deployment_id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "build_session_id" text,
  "workspace_id" text NOT NULL REFERENCES "cloud_workspace"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL,
  "provider_workspace_id" text,
  "owner_token" text,
  "resources" jsonb,
  "reserved_at" timestamp DEFAULT now() NOT NULL,
  "commands" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "started_at" timestamp,
  "finished_at" timestamp,
  "slot_released_at" timestamp
);
--> statement-breakpoint
CREATE INDEX "cloud_build_activity_open_workspace_idx" ON "cloud_build_activity" ("workspace_id") WHERE "finished_at" IS NULL;
