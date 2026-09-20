-- Older route-sync writes could mark a new primary without clearing the old
-- one. Keep the most recently touched row: it is the best durable signal for
-- the user's last selection, with creation time and id as deterministic ties.
WITH ranked_primaries AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "project_id"
      ORDER BY "updated_at" DESC, "created_at" DESC, "id" DESC
    ) AS "rank"
  FROM "domain"
  WHERE "project_id" IS NOT NULL AND "is_primary" = true
)
UPDATE "domain"
SET "is_primary" = false, "updated_at" = now()
WHERE "id" IN (
  SELECT "id" FROM ranked_primaries WHERE "rank" > 1
);
--> statement-breakpoint
-- Repository transactions make promotion orderly; this index makes the
-- invariant impossible to bypass through another writer or a concurrent race.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_domain_project_primary"
  ON "domain" ("project_id")
  WHERE "is_primary" = true AND "project_id" IS NOT NULL;
