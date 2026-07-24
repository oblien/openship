CREATE TABLE "project_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"source_project_id" text NOT NULL,
	"target_project_id" text NOT NULL,
	"output_id" text NOT NULL,
	"env_key" text NOT NULL,
	"mode" text DEFAULT 'public' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_connection" ADD CONSTRAINT "project_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_connection" ADD CONSTRAINT "project_connection_source_project_id_project_id_fk" FOREIGN KEY ("source_project_id") REFERENCES "public"."project"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_connection" ADD CONSTRAINT "project_connection_target_project_id_project_id_fk" FOREIGN KEY ("target_project_id") REFERENCES "public"."project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_project_connection_target_env" ON "project_connection" USING btree ("target_project_id","env_key");--> statement-breakpoint
CREATE INDEX "idx_project_connection_target" ON "project_connection" USING btree ("target_project_id");--> statement-breakpoint
CREATE INDEX "idx_project_connection_source" ON "project_connection" USING btree ("source_project_id");