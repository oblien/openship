CREATE TABLE "action_command" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "workflow_id" text NOT NULL,
  "idempotency_key" text NOT NULL,
  "request_hash" text NOT NULL,
  "state" text NOT NULL DEFAULT 'submitted',
  "remote_run_id" text,
  "remote_attempt" integer,
  "error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now(),
  CONSTRAINT "action_command_workflow_owner_fk" FOREIGN KEY ("workflow_id", "organization_id") REFERENCES "action_workflow" ("id", "organization_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "action_command_key_unique" ON "action_command" ("organization_id", "idempotency_key");
