ALTER TABLE "chat_app_connection" ADD COLUMN "assistant_allowed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_app_identity"
 ADD COLUMN "assistant_provider" text,
 ADD COLUMN "assistant_model" text DEFAULT '' NOT NULL,
 ADD COLUMN "assistant_revision" integer DEFAULT 1 NOT NULL,
 ADD COLUMN "assistant_authority" jsonb,
 ADD COLUMN "assistant_fingerprint" text;
--> statement-breakpoint
CREATE TABLE "chat_app_thread" (
 "id" text PRIMARY KEY NOT NULL,
 "identity_id" text NOT NULL REFERENCES "chat_app_identity"("id") ON DELETE CASCADE,
 "sender_key" text NOT NULL,
 "connection_revision" integer NOT NULL,
 "identity_revision" integer NOT NULL,
 "conversation_id" text NOT NULL UNIQUE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_app_thread_sender_idx" ON "chat_app_thread" ("identity_id", "sender_key");
--> statement-breakpoint
ALTER TABLE "assistant_conversation" ADD COLUMN "chat_thread_id" text;
--> statement-breakpoint
ALTER TABLE "chat_app_command"
 ADD COLUMN "conversation_id" text,
 ADD COLUMN "delivery" text,
 ADD COLUMN "identity_id" text;
