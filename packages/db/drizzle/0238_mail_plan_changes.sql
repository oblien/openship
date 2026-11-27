ALTER TABLE managed_mail_account ADD COLUMN subscription_change jsonb;
--> statement-breakpoint
ALTER TABLE managed_mail_service ADD COLUMN subscription_change jsonb;
