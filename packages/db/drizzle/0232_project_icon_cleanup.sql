-- Preserve saved images before retiring automatic favicon discovery.
-- An explicit icon always wins; projects without one retain their existing image.
UPDATE "project"
SET "icon_url" = COALESCE(
  "icon_url",
  "favicon",
  (SELECT "favicon" FROM "project_app" WHERE "id" = "project"."app_id")
)
WHERE "icon_url" IS NULL;
--> statement-breakpoint
ALTER TABLE "project" DROP COLUMN IF EXISTS "favicon";
--> statement-breakpoint
ALTER TABLE "project" DROP COLUMN IF EXISTS "favicon_checked_at";
--> statement-breakpoint
ALTER TABLE "project_app" DROP COLUMN IF EXISTS "favicon";
--> statement-breakpoint
ALTER TABLE "project_app" DROP COLUMN IF EXISTS "favicon_checked_at";
