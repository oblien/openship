CREATE TABLE "webhook_source" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"secret" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "domain" ALTER COLUMN "project_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "owner_type" text DEFAULT 'project' NOT NULL;--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN "webhook_source_id" text;--> statement-breakpoint
ALTER TABLE "webhook_source" ADD CONSTRAINT "webhook_source_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_webhook_source_org" ON "webhook_source" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "domain" ADD CONSTRAINT "domain_webhook_source_id_webhook_source_id_fk" FOREIGN KEY ("webhook_source_id") REFERENCES "public"."webhook_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_domain_webhook_source" ON "domain" USING btree ("webhook_source_id");