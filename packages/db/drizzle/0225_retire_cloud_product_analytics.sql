-- Retire the former product-telemetry outbox and its correlation mirrors.
-- Authoritative billing, subscriptions and audit records are separate tables.
DROP TABLE IF EXISTS "cloud_analytics_event";
--> statement-breakpoint
DROP TABLE IF EXISTS "cloud_analytics_checkout";
--> statement-breakpoint
DROP TABLE IF EXISTS "cloud_analytics_workspace";
