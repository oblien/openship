CREATE TABLE "advisory_feed" (
  "id" text PRIMARY KEY NOT NULL,
  "body" jsonb,
  "etag" text,
  "revision" bigint DEFAULT 0 NOT NULL,
  "authentication_rejected" boolean DEFAULT false NOT NULL,
  "checked_at" timestamp,
  "next_check_at" timestamp DEFAULT now() NOT NULL,
  "lease_until" timestamp,
  "failures" integer DEFAULT 0 NOT NULL,
  "error" text
);
--> statement-breakpoint
CREATE TABLE "project_security" (
  "project_id" text PRIMARY KEY NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "deployment_id" text,
  "inventory" jsonb,
  "checked_at" timestamp,
  "auto_refresh" boolean DEFAULT false NOT NULL,
  "evaluated_at" timestamp,
  "feed_revision" bigint DEFAULT 0 NOT NULL,
  "approved_by" text REFERENCES "user"("id") ON DELETE SET NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "idx_project_security_org" ON "project_security" ("organization_id");
--> statement-breakpoint
CREATE TABLE "security_refresh_attempt" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "status" text DEFAULT 'pending' NOT NULL,
  "deployment_id" text,
  "advisory_id" text,
  "action_request_id" text,
  "service_id" text,
  "image" text,
  "error" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
