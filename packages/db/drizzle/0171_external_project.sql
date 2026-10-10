ALTER TABLE "project" ADD COLUMN "external_config" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ix_service_deployment_container" ON "service_deployment" ("container_id");
