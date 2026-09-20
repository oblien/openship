-- Deployment-class axes — deconflate the legacy `has_server` / `has_build`
-- booleans, which each mixed two independent concerns (issue #538). See
-- @repo/core deployment-class.ts.
--
-- All three are EXPLICIT OVERRIDES: NULL means "derive from the legacy flags +
-- framework + source", so every pre-existing project keeps classifying exactly
-- as before and no backfill is needed. `has_server` / `has_build` are kept and
-- written in sync, never dropped — rollback snapshots and every legacy reader
-- still depend on them.
--
--   source_kind    text  "git" | "image" | "upload"      (git needs a clone)
--   build_kind     text  "dockerfile" | "buildpack" | "static" | "prebuilt"
--   workload_type  text  "web" | "worker" | "static"     (worker = portless
--                        long-running container: no port, no route)
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "source_kind" text;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "build_kind" text;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "workload_type" text;
