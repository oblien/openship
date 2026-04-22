CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
	"owner" text NOT NULL,
	"repo" text NOT NULL,
	"branch" text DEFAULT 'main' NOT NULL,
	"project_id" text NOT NULL,
	"hook_id" text NOT NULL,
	"webhook_secret" text NOT NULL,
	"server_id" text,
	"github_webhook_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_sub_hook_id_idx" ON "webhook_subscriptions" ("hook_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action,
	"event_type" text DEFAULT 'push' NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"delivered_at" timestamp
);