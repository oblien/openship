CREATE TABLE "custom_app_template" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"app_id" text NOT NULL,
	"template" jsonb NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "custom_app_template" ADD CONSTRAINT "custom_app_template_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_app_template" ADD CONSTRAINT "custom_app_template_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_custom_app_template_org_app" ON "custom_app_template" USING btree ("organization_id","app_id");--> statement-breakpoint
CREATE INDEX "idx_custom_app_template_org" ON "custom_app_template" USING btree ("organization_id");
