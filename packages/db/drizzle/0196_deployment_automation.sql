ALTER TABLE "project" ADD COLUMN "preview_settings" jsonb;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "build_cache_receipts" jsonb;
--> statement-breakpoint
CREATE TABLE "pull_request_preview" (
  "id" text PRIMARY KEY, "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "source_project_id" text NOT NULL, "project_id" text REFERENCES "project"("id") ON DELETE SET NULL,
  "owner" text NOT NULL, "repo" text NOT NULL, "number" integer NOT NULL,
  "head_sha" text, "deployment_id" text, "status" text NOT NULL DEFAULT 'pending', "url" text,
  "comment_id" text, "published_digest" text, "error" text,
  "next_attempt_at" timestamp DEFAULT now(), "lease_token" text, "lease_expires_at" timestamp,
  "updated_at" timestamp NOT NULL DEFAULT now(), "created_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "pull_request_preview_source_number" ON "pull_request_preview" ("source_project_id", "number");
--> statement-breakpoint
CREATE INDEX "pull_request_preview_due" ON "pull_request_preview" ("next_attempt_at");
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN "preview_scanned_at" timestamp;
