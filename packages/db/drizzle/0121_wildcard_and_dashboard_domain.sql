CREATE TABLE IF NOT EXISTS "wildcard_domain" (
	"id" text PRIMARY KEY NOT NULL,
	"domain" text NOT NULL,
	"apex" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"dns_provider" text DEFAULT 'manual',
	"dns_zone_id" text,
	"dns_record_id" text,
	"ssl_status" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "wildcard_domain_domain_unique" UNIQUE("domain")
);
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "dashboard_domain" text;
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "dashboard_dns_zone_id" text;
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "dashboard_dns_record_id" text;
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "dashboard_ssl_status" text DEFAULT 'none' NOT NULL;
