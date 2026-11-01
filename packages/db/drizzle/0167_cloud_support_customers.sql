ALTER TABLE "cloud_support_ticket" ADD COLUMN "owner_user_id" text;
--> statement-breakpoint
ALTER TABLE "cloud_support_ticket" ADD COLUMN "category" text DEFAULT 'general' NOT NULL;
--> statement-breakpoint
ALTER TABLE "cloud_support_ticket" ADD CONSTRAINT "cloud_support_ticket_category_check"
  CHECK ("category" IN ('deployment', 'billing', 'account', 'general'));
--> statement-breakpoint
CREATE INDEX "cloud_support_ticket_owner_created"
  ON "cloud_support_ticket" ("owner_user_id", "created_at", "id");
--> statement-breakpoint
ALTER TABLE "cloud_support_message" DROP CONSTRAINT "cloud_support_message_kind_check";
--> statement-breakpoint
ALTER TABLE "cloud_support_message" ADD CONSTRAINT "cloud_support_message_kind_check"
  CHECK ("kind" IN ('receipt', 'notification', 'reply', 'customer_reply'));
