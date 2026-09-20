ALTER TABLE "project_connection" ADD COLUMN "source_service_id" text;
--> statement-breakpoint
ALTER TABLE "project_connection" ADD COLUMN "uses_private_network" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "project_connection" ADD CONSTRAINT "project_connection_source_service_id_service_id_fk"
  FOREIGN KEY ("source_service_id") REFERENCES "public"."service"("id") ON DELETE restrict ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "idx_project_connection_source_service" ON "project_connection" USING btree ("source_service_id");
