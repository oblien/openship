ALTER TABLE "assistant_conversation" ADD COLUMN "automation_run_id" text;
--> statement-breakpoint
CREATE TABLE "assistant_automation_settings" (
 "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
 "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
 "paused" boolean DEFAULT false NOT NULL,
 PRIMARY KEY ("user_id", "organization_id")
);
--> statement-breakpoint
CREATE TABLE "assistant_automation" (
 "id" text PRIMARY KEY, "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
 "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
 "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
 "name" text NOT NULL, "trigger" text NOT NULL, "provider" text NOT NULL, "model" text DEFAULT '' NOT NULL,
 "mode" text DEFAULT 'report' NOT NULL, "action" text DEFAULT 'none' NOT NULL, "instructions" text DEFAULT '' NOT NULL,
 "channel_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
 "cooldown_minutes" integer DEFAULT 30 NOT NULL, "daily_limit" integer DEFAULT 5 NOT NULL,
 "enabled" boolean DEFAULT false NOT NULL, "revision" integer DEFAULT 1 NOT NULL, "authority" jsonb NOT NULL, "access_fingerprint" text NOT NULL,
 "last_started_at" timestamp, "armed_at" timestamp DEFAULT now() NOT NULL, "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "assistant_automation_event_idx" ON "assistant_automation" ("organization_id", "project_id", "trigger");
--> statement-breakpoint
CREATE INDEX "assistant_automation_owner_idx" ON "assistant_automation" ("organization_id", "user_id");
--> statement-breakpoint
CREATE TABLE "assistant_automation_run" (
 "id" text PRIMARY KEY, "automation_id" text NOT NULL REFERENCES "assistant_automation"("id") ON DELETE CASCADE,
 "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
 "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
 "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
 "revision" integer NOT NULL, "definition" jsonb NOT NULL, "event_key" text NOT NULL, "deployment_id" text NOT NULL, "incident_id" text,
 "state" text DEFAULT 'queued' NOT NULL, "message" text DEFAULT 'Waiting to investigate.' NOT NULL,
 "conversation_id" text, "token_id" text, "token" text, "result_deployment_id" text,
 "action_claimed_at" timestamp, "expires_at" timestamp, "lease_owner" text, "lease_until" timestamp, "notified_at" timestamp,
 "created_at" timestamp DEFAULT now() NOT NULL, "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_automation_event_once" ON "assistant_automation_run" ("automation_id", "event_key");
--> statement-breakpoint
CREATE INDEX "assistant_automation_run_queue_idx" ON "assistant_automation_run" ("state", "updated_at");
--> statement-breakpoint
CREATE INDEX "assistant_automation_run_project_idx" ON "assistant_automation_run" ("organization_id", "project_id");
