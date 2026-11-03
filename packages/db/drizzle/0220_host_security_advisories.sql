ALTER TABLE "project_security" ADD COLUMN IF NOT EXISTS "next_inspection_at" timestamp;
--> statement-breakpoint
ALTER TABLE "project_security" ADD COLUMN IF NOT EXISTS "probe_failures" integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "project_security_due_idx" ON "project_security" ("next_inspection_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "server_security" (
  "server_id" text PRIMARY KEY REFERENCES "servers"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "inventory" jsonb, "checked_at" timestamp, "next_inspection_at" timestamp,
  "probe_key" text, "probe_failures" integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "server_security_org_idx" ON "server_security" ("organization_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "server_security_due_idx" ON "server_security" ("next_inspection_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "security_scan_state" (
  "organization_id" text PRIMARY KEY REFERENCES "organization"("id") ON DELETE CASCADE,
  "started_at" timestamp NOT NULL, "finished_at" timestamp, "status" text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "job_run_server_started_idx" ON "job_run" ("server_id", "started_at");
