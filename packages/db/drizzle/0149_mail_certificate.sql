ALTER TABLE "mail_servers" ADD COLUMN "certificate_auto_renew" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "mail_servers" ADD COLUMN "certificate_health" jsonb;
--> statement-breakpoint
ALTER TABLE "mail_servers" ADD COLUMN "certificate_renewal_error" text;
