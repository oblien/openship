-- Durable server ownership on the project.
--
-- A project's deploy target lived ONLY in the active deployment's volatile
-- meta.serverId. When resolveSnapshotTarget couldn't re-derive that binding from
-- a fresh/partial snapshot, the deploy fell back to "local", which then nulled
-- the project's verified custom-domain ports and regressed the Access URL to
-- localhost:3000. This makes the server binding a durable, first-class column.
--
-- cloudWorkspaceId still owns "is this a cloud project", so we deliberately do
-- NOT add a deployTarget column (that would be a second source of truth for the
-- same fact); the effective target is derived — cloudWorkspaceId ? "cloud" :
-- server_id ? "server" : "local".
--
-- ON DELETE SET NULL: removing a server unbinds its projects rather than
-- cascade-deleting them.
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "server_id" text REFERENCES "servers"("id") ON DELETE SET NULL;
--> statement-breakpoint
-- Backfill the binding from each project's active-deployment meta so existing
-- server-hosted projects survive the next redeploy without regressing to local.
UPDATE "project" SET "server_id" = (
  SELECT d."meta"->>'serverId'
  FROM "deployment" d
  WHERE d."id" = "project"."active_deployment_id"
)
WHERE "server_id" IS NULL
  AND "active_deployment_id" IS NOT NULL;
