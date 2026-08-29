-- Rollback retention: auto-sized window inputs on the project, and the removal
-- of a per-service artifact flag that was never written or read.
--
-- `rollback_window` keeps its existing meaning with one addition: NULL now means
-- "auto" — resolve to `rollback_window_computed` (measured from the deploy host's
-- free disk and this project's average snapshot size), falling back to
-- instance_settings.default_rollback_window when nothing was measured yet. A
-- non-null `rollback_window` is still an explicit operator override.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "snapshot_size_bytes" bigint;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "rollback_window_computed" integer;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "capacity_measured_at" timestamp;
--> statement-breakpoint
-- Dead since it was introduced: the deployment-level `artifact_retained_at` is
-- the only retention flag any code path writes or reads.
ALTER TABLE "service_deployment" DROP COLUMN IF EXISTS "artifact_retained_at";
