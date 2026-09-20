-- GitHub App installations belong to an Openship workspace, not to whichever
-- user happened to connect them. Keep the most recently reconciled legacy row
-- for each workspace/owner before installing the new uniqueness boundary.
ALTER TABLE "git_installation" ADD COLUMN IF NOT EXISTS "suspended_at" timestamp;
--> statement-breakpoint

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY provider, lower(owner), organization_id
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS rn
  FROM git_installation
)
DELETE FROM git_installation
WHERE id IN (SELECT id FROM ranked WHERE rn > 1);
--> statement-breakpoint

DROP INDEX IF EXISTS "uq_git_installation_provider_owner_user";
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_git_installation_provider_owner_org"
  ON "git_installation" ("provider", "owner", "organization_id");
