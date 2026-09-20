-- Per-service Docker Compose build arguments (#689).
--
-- These cannot share `service.environment`: build args configure image creation,
-- while environment configures the resulting container. Keeping them in a dedicated
-- JSONB column preserves the compose service boundary (two services may build one
-- Dockerfile with different args) and lets drift reconciliation compare them without
-- a schema change for every individual ARG name.
ALTER TABLE "service"
  ADD COLUMN IF NOT EXISTS "build_args" jsonb DEFAULT '{}'::jsonb NOT NULL;
