CREATE TABLE "cloud_workspace" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
  "name" text NOT NULL,
  "mode" text DEFAULT 'shared' NOT NULL,
  "runtime" text DEFAULT 'docker' NOT NULL,
  "namespace" text,
  "plan_tier_id" text DEFAULT 'free' NOT NULL,
  "subscription_status" text DEFAULT 'active' NOT NULL,
  "current_period_start" timestamp,
  "current_period_end" timestamp,
  "deletion_in_progress" timestamp,
  "operation" jsonb,
  "pending_checkouts" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "cloud_workspace_mode_check" CHECK ("mode" IN ('shared', 'dedicated')),
  CONSTRAINT "cloud_workspace_runtime_check" CHECK ("runtime" IN ('docker', 'native') AND ("mode" <> 'shared' OR "runtime" = 'docker'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_workspace_namespace_unique" ON "cloud_workspace" ("namespace");
--> statement-breakpoint
CREATE UNIQUE INDEX "cloud_workspace_id_org_unique" ON "cloud_workspace" ("id", "organization_id");
--> statement-breakpoint
CREATE INDEX "cloud_workspace_org_idx" ON "cloud_workspace" ("organization_id");
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "workspace_id" text;
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_owner_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "cloud_workspace" ("id", "organization_id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_target_check" CHECK ("workspace_id" IS NULL OR ("server_id" IS NULL AND "cluster_id" IS NULL));
--> statement-breakpoint
CREATE INDEX "project_workspace_idx" ON "project" ("workspace_id");
--> statement-breakpoint
ALTER TABLE "cloud_docker_workspace" ADD COLUMN "id" text DEFAULT gen_random_uuid()::text NOT NULL;
--> statement-breakpoint
ALTER TABLE "cloud_docker_workspace" DROP CONSTRAINT "cloud_docker_workspace_pkey";
--> statement-breakpoint
ALTER TABLE "cloud_docker_workspace" ADD PRIMARY KEY ("id");
--> statement-breakpoint
ALTER TABLE "cloud_docker_workspace" ALTER COLUMN "project_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "cloud_docker_workspace" ADD COLUMN "owner_workspace_id" text REFERENCES "cloud_workspace"("id") ON DELETE RESTRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cloud_docker_project_owner" ON "cloud_docker_workspace" ("project_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cloud_docker_workspace_owner" ON "cloud_docker_workspace" ("owner_workspace_id");
--> statement-breakpoint
ALTER TABLE "cloud_docker_workspace" ADD CONSTRAINT "cloud_docker_workspace_owner_check" CHECK (("project_id" IS NULL) <> ("owner_workspace_id" IS NULL));
--> statement-breakpoint
DROP INDEX "billing_plan_grant_current_org";
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_plan_grant_current_namespace" ON "billing_plan_grant" ("organization_id", "namespace") WHERE "released_at" IS NULL;
