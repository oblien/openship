CREATE TABLE "action_runner_session" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization" ("id") ON DELETE CASCADE,
  "workflow_id" text NOT NULL,
  "runner_id" text NOT NULL,
  "demand_job_id" text NOT NULL,
  "repo_owner" text NOT NULL,
  "repo_name" text NOT NULL,
  "runner_name" text NOT NULL,
  "github_runner_id" text,
  "registration" text,
  "registration_expires_at" timestamp,
  "spec" jsonb NOT NULL,
  "directory" text,
  "worker_binary" text,
  "provider_workspace_id" text,
  "provider_requested_at" timestamp,
  "worker_started_at" timestamp,
  "last_event_sequence" integer NOT NULL DEFAULT 0,
  "state" text NOT NULL DEFAULT 'preparing',
  "cancel_requested_at" timestamp,
  "finished_at" timestamp,
  "cleaned_at" timestamp,
  "lease_owner" text,
  "lease_until" timestamp,
  "error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "action_runner_session_workflow_owner_fk" FOREIGN KEY ("workflow_id", "organization_id") REFERENCES "action_workflow" ("id", "organization_id") ON DELETE RESTRICT,
  CONSTRAINT "action_runner_session_runner_owner_fk" FOREIGN KEY ("runner_id", "organization_id") REFERENCES "action_runner" ("id", "organization_id") ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX "action_runner_session_name_unique" ON "action_runner_session" ("runner_name");
--> statement-breakpoint
CREATE UNIQUE INDEX "action_runner_session_demand_unique" ON "action_runner_session" ("organization_id", "demand_job_id") WHERE "cleaned_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "action_runner_session_pending_idx" ON "action_runner_session" ("cleaned_at", "lease_until");
