CREATE TABLE IF NOT EXISTS "cluster_storage" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "cluster_id" text NOT NULL REFERENCES "compute_cluster"("id") ON DELETE CASCADE,
  "runtime_id" text NOT NULL REFERENCES "cluster_runtime"("id") ON DELETE CASCADE,
  "request_id" text NOT NULL,
  "config" jsonb NOT NULL,
  "status" text DEFAULT 'setting_up' NOT NULL,
  "intent" text DEFAULT 'setup' NOT NULL,
  "generation" integer DEFAULT 1 NOT NULL,
  "sequence" integer DEFAULT 1 NOT NULL,
  "progress" jsonb DEFAULT '{"steps":[],"logs":[]}'::jsonb NOT NULL,
  "observation" jsonb,
  "error" text,
  "lease_expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "cluster_storage_status_check" CHECK ("status" IN ('setting_up','ready','failed','interrupted','removing','removed')),
  CONSTRAINT "cluster_storage_intent_check" CHECK ("intent" IN ('setup','remove'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "cluster_storage_cluster_idx" ON "cluster_storage" ("cluster_id");
