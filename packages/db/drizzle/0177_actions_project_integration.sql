ALTER TABLE "action_workflow" ALTER COLUMN "owner" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "action_workflow" ALTER COLUMN "repo" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "action_workflow" ADD CONSTRAINT "action_workflow_source_check" CHECK (("owner" IS NOT NULL AND "repo" IS NOT NULL) OR ("owner" IS NULL AND "repo" IS NULL AND "source" IS NOT NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX "project_owner_unique" ON "project" ("id", "organization_id");
--> statement-breakpoint
CREATE TABLE "action_project" (
  "organization_id" text NOT NULL,
  "workflow_id" text NOT NULL,
  "project_id" text NOT NULL,
  "required" boolean NOT NULL DEFAULT false,
  "created_at" timestamp NOT NULL DEFAULT now(),
  PRIMARY KEY ("workflow_id", "project_id"),
  CONSTRAINT "action_project_workflow_owner_fk" FOREIGN KEY ("workflow_id", "organization_id") REFERENCES "action_workflow" ("id", "organization_id") ON DELETE CASCADE,
  CONSTRAINT "action_project_project_owner_fk" FOREIGN KEY ("project_id", "organization_id") REFERENCES "project" ("id", "organization_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX "action_project_project_idx" ON "action_project" ("project_id", "organization_id");
--> statement-breakpoint
CREATE TABLE "action_deployment" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL,
  "project_id" text NOT NULL,
  "revision" text NOT NULL,
  "ref" text NOT NULL,
  "requirements" jsonb NOT NULL,
  "intent" jsonb NOT NULL,
  "authority" jsonb NOT NULL,
  "status" text NOT NULL DEFAULT 'waiting',
  "deployment_id" text,
  "error" text,
  "lease_owner" text,
  "lease_until" timestamp,
  "retry_at" timestamp NOT NULL DEFAULT now(),
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "action_deployment_project_owner_fk" FOREIGN KEY ("project_id", "organization_id") REFERENCES "project" ("id", "organization_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "action_deployment_commit_unique" ON "action_deployment" ("project_id", "revision");
--> statement-breakpoint
CREATE INDEX "action_deployment_pending_idx" ON "action_deployment" ("status", "retry_at");
--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN "action_request_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX "deployment_action_request_unique" ON "deployment" ("action_request_id");
