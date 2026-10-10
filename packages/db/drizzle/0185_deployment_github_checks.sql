ALTER TABLE "project" ADD COLUMN "github_checks" jsonb;
--> statement-breakpoint
ALTER TABLE "deployment_check_run" ALTER COLUMN "check_run_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "deployment_check_run"
  ADD COLUMN "source" jsonb,
  ADD COLUMN "service_name" text,
  ADD COLUMN "published_digest" text,
  ADD COLUMN "next_attempt_at" timestamp,
  ADD COLUMN "lease_token" text,
  ADD COLUMN "lease_expires_at" timestamp,
  ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL,
  ADD COLUMN "last_error" text;
--> statement-breakpoint
CREATE INDEX "ix_deployment_check_run_due" ON "deployment_check_run" ("next_attempt_at")
  WHERE "kind" = 'rollup' AND "next_attempt_at" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_deployment_check_run_service_name"
  ON "deployment_check_run" ("deployment_id", "service_name") WHERE "kind" = 'service';
