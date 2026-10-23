ALTER TABLE "instance_settings" ADD COLUMN "autoscaler_disabled" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE TABLE "project_autoscale_policy" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "enabled" integer DEFAULT 0 NOT NULL,
  "target_cpu_percent" integer NOT NULL,
  "min_replicas" integer NOT NULL,
  "max_replicas" integer NOT NULL,
  "step_size" integer DEFAULT 1 NOT NULL,
  "cooldown_seconds" integer DEFAULT 120 NOT NULL,
  "suspend_after_failures" integer DEFAULT 3 NOT NULL,
  "next_attempt_at" timestamp,
  "failure_count" integer DEFAULT 0 NOT NULL,
  "suspended_at" timestamp,
  "suspended_reason" text,
  "last_decision" jsonb,
  "pending_scale" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "project_autoscale_policy_project_id_unique" UNIQUE ("project_id")
);
--> statement-breakpoint
ALTER TABLE "project_autoscale_policy" ADD CONSTRAINT "project_autoscale_policy_failures_check" CHECK ("suspend_after_failures" BETWEEN 1 AND 10);
--> statement-breakpoint
ALTER TABLE "project_autoscale_policy" ADD CONSTRAINT "project_autoscale_policy_cpu_check" CHECK ("target_cpu_percent" BETWEEN 1 AND 100);
--> statement-breakpoint
ALTER TABLE "project_autoscale_policy" ADD CONSTRAINT "project_autoscale_policy_bounds_check" CHECK ("min_replicas" >= 1 AND "max_replicas" >= "min_replicas" AND "max_replicas" <= 100);
--> statement-breakpoint
ALTER TABLE "project_autoscale_policy" ADD CONSTRAINT "project_autoscale_policy_step_check" CHECK ("step_size" BETWEEN 1 AND 10 AND "cooldown_seconds" >= 30 AND "cooldown_seconds" <= 3600);
--> statement-breakpoint
CREATE TABLE "project_autoscale_event" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "action" text NOT NULL,
  "from_replicas" integer NOT NULL,
  "to_replicas" integer,
  "observed_cpu_percent" integer,
  "cooldown_seconds" integer,
  "reason" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "project_autoscale_event_recent_idx" ON "project_autoscale_event" ("project_id", "created_at");