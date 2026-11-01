-- Intent must survive a controller crash independently of deployment outcomes.
-- Existing deployments have no journal and retain their current behavior.
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "role_handover" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_deployment_role_handover_pending" ON "deployment" ("project_id")
WHERE "role_handover" IS NOT NULL AND coalesce("role_handover"->>'phase', '') <> 'complete';
