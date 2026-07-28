CREATE TABLE "webhook_delivery" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text,
	"project_id" text,
	"source" text NOT NULL,
	"hook_id" text,
	"delivery_id" text,
	"event" text NOT NULL,
	"auth_result" text,
	"outcome" text NOT NULL,
	"action_ref" text,
	"status_code" integer,
	"error" text,
	"summary" jsonb,
	"client_ip" text,
	"user_agent" text,
	"duration_ms" integer,
	"received_at" timestamp DEFAULT now() NOT NULL,
	"processed_at" timestamp
);
--> statement-breakpoint
DROP TABLE IF EXISTS "github_webhook_event";--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_delivery" ADD CONSTRAINT "webhook_delivery_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_webhook_delivery_github_delivery" ON "webhook_delivery" USING btree ("source","delivery_id") WHERE "webhook_delivery"."source" = 'github' AND "webhook_delivery"."delivery_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "idx_webhook_delivery_project" ON "webhook_delivery" USING btree ("project_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_webhook_delivery_org" ON "webhook_delivery" USING btree ("organization_id","received_at");--> statement-breakpoint
CREATE INDEX "idx_webhook_delivery_hook" ON "webhook_delivery" USING btree ("hook_id","received_at");
