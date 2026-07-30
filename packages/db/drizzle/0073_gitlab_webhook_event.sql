CREATE TABLE "gitlab_webhook_event" (
	"delivery_id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "gitlab_clone_token_encrypted" text;--> statement-breakpoint
ALTER TABLE "user_settings" ADD COLUMN "gitlab_clone_token_set_at" timestamp;
