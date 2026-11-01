CREATE TABLE "cluster_database" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "cluster_id" text NOT NULL REFERENCES "compute_cluster"("id") ON DELETE CASCADE,
  "runtime_id" text NOT NULL REFERENCES "cluster_runtime"("id") ON DELETE CASCADE,
  "request_id" text NOT NULL,
  "name" text NOT NULL,
  "config" jsonb NOT NULL,
  "secret_encrypted" text NOT NULL,
  "status" text DEFAULT 'provisioning' NOT NULL,
  "intent" text DEFAULT 'apply' NOT NULL,
  "delete_data" boolean DEFAULT false NOT NULL,
  "generation" integer DEFAULT 1 NOT NULL,
  "sequence" integer DEFAULT 1 NOT NULL,
  "progress" jsonb DEFAULT '{"steps":[],"logs":[]}'::jsonb NOT NULL,
  "observation" jsonb,
  "error" text,
  "env_key" text,
  "env_value_encrypted" text,
  "lease_expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "cluster_database_status_check" CHECK ("status" IN ('provisioning','ready','failed','interrupted','deleting','retained','deleted')),
  CONSTRAINT "cluster_database_intent_check" CHECK ("intent" IN ('apply','remove'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_database_request_idx" ON "cluster_database" ("project_id","request_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_database_name_idx" ON "cluster_database" ("project_id","name") WHERE "status" <> 'deleted';
--> statement-breakpoint
CREATE INDEX "cluster_database_runtime_idx" ON "cluster_database" ("runtime_id","status");
