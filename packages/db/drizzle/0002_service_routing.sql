ALTER TABLE "service" ADD COLUMN "exposed" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "exposed_port" text;
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "domain" text;
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "custom_domain" text;
--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN "domain_type" text DEFAULT 'free';