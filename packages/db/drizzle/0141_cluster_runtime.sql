CREATE TABLE "cluster_runtime" (
  "id" text PRIMARY KEY NOT NULL,
  "cluster_id" text NOT NULL REFERENCES "compute_cluster"("id") ON DELETE NO ACTION,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "cluster_revision" integer NOT NULL,
  "request_id" text NOT NULL,
  "provider" text DEFAULT 'k3s' NOT NULL,
  "status" text NOT NULL,
  "intent" text DEFAULT 'setup' NOT NULL,
  "generation" integer DEFAULT 1 NOT NULL,
  "sequence" integer DEFAULT 1 NOT NULL,
  "plan" jsonb NOT NULL,
  "error" text,
  "lease_expires_at" timestamp,
  "verified_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "cluster_runtime_provider_check" CHECK ("provider" = 'k3s'),
  CONSTRAINT "cluster_runtime_status_check" CHECK ("status" IN ('setting_up','ready','failed','interrupted','removing','removed')),
  CONSTRAINT "cluster_runtime_intent_check" CHECK ("intent" IN ('setup','remove'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_runtime_cluster_idx" ON "cluster_runtime" ("cluster_id");
--> statement-breakpoint
CREATE INDEX "cluster_runtime_org_status_idx" ON "cluster_runtime" ("organization_id", "status");
