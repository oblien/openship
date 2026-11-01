ALTER TABLE "chat_app_connection" ADD COLUMN "purpose" text NOT NULL DEFAULT 'commands';
--> statement-breakpoint
UPDATE "chat_app_connection" SET "purpose" = 'both' WHERE "assistant_allowed" = true;
--> statement-breakpoint
ALTER TABLE "chat_app_thread" ADD COLUMN "active" boolean NOT NULL DEFAULT true;
--> statement-breakpoint
DROP INDEX "chat_app_thread_sender_idx";
--> statement-breakpoint
CREATE INDEX "chat_app_thread_sender_idx" ON "chat_app_thread" ("identity_id", "sender_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "chat_app_thread_active_idx" ON "chat_app_thread" ("identity_id", "sender_key") WHERE "active" = true;
--> statement-breakpoint
ALTER TABLE "chat_app_command" ADD COLUMN "assistant_request_id" text;
--> statement-breakpoint
UPDATE "chat_app_command" SET "assistant_request_id" = "id" WHERE "conversation_id" IS NOT NULL;
