CREATE TABLE "incoming_webhook" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"action_type" text NOT NULL,
	"action_config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"auth_mode" text DEFAULT 'token' NOT NULL,
	"token_encrypted" text,
	"hmac_secret_encrypted" text,
	"created_by" text,
	"last_fired_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incoming_webhook" ADD CONSTRAINT "incoming_webhook_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incoming_webhook" ADD CONSTRAINT "incoming_webhook_project_id_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idx_incoming_webhook_project" ON "incoming_webhook" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "idx_incoming_webhook_org" ON "incoming_webhook" USING btree ("organization_id");
