DROP TABLE IF EXISTS "billing_usage_snapshot";--> statement-breakpoint
DROP TABLE IF EXISTS "billing_anniversary_grant";--> statement-breakpoint
DROP TABLE IF EXISTS "stripe_topup_grant";--> statement-breakpoint
DROP TABLE IF EXISTS "stripe_webhook_event";--> statement-breakpoint
DROP TABLE IF EXISTS "oblien_webhook_event";--> statement-breakpoint
DROP TABLE IF EXISTS "billing_subscription";--> statement-breakpoint
DROP TABLE IF EXISTS "billing_customer";--> statement-breakpoint
DROP TABLE IF EXISTS "credit_pack";--> statement-breakpoint
DROP TABLE IF EXISTS "cloud_handoff_code";--> statement-breakpoint
DROP TABLE IF EXISTS "cloud_webhook_binding";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN IF EXISTS "stripe_customer_id";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN IF EXISTS "plan_tier_id";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN IF EXISTS "subscription_status";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN IF EXISTS "current_period_start";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN IF EXISTS "current_period_end";--> statement-breakpoint
ALTER TABLE "organization" DROP COLUMN IF EXISTS "oblien_namespace";
