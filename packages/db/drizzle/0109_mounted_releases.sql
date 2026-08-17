-- A project can advance its mounted source tree without replacing the runtime
-- container. These two pointers intentionally describe different live assets.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "active_release_deployment_id" text;--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "mounted_release" jsonb;
