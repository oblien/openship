CREATE TABLE "action_delivery" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "workflow_id" text NOT NULL,
  "delivery_id" text NOT NULL,
  "event_name" text NOT NULL,
  "payload" jsonb NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "retry_at" timestamp DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_until" timestamp,
  "error" text,
  "finished_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "action_delivery_workflow_owner_fk" FOREIGN KEY ("workflow_id", "organization_id") REFERENCES "action_workflow"("id", "organization_id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "action_delivery_workflow_unique" ON "action_delivery" ("workflow_id", "delivery_id");
--> statement-breakpoint
CREATE INDEX "action_delivery_pending_idx" ON "action_delivery" ("finished_at", "retry_at", "lease_until");
