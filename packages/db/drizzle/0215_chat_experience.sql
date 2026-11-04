ALTER TABLE "user_settings" ADD COLUMN "locale" text DEFAULT 'en' NOT NULL;
--> statement-breakpoint
ALTER TABLE "chat_app_inbox" ADD COLUMN "delivered_count" integer DEFAULT 0 NOT NULL;
