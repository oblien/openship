ALTER TABLE "two_factor" ADD COLUMN IF NOT EXISTS "verified" boolean;
--> statement-breakpoint
UPDATE "two_factor" AS factor
SET "verified" = EXISTS (
  SELECT 1 FROM "user" WHERE "user"."id" = factor."user_id" AND "user"."two_factor_enabled" = true
)
WHERE factor."verified" IS NULL;
--> statement-breakpoint
ALTER TABLE "two_factor" ALTER COLUMN "verified" SET DEFAULT true;
--> statement-breakpoint
ALTER TABLE "two_factor" ALTER COLUMN "verified" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN IF NOT EXISTS "failed_verification_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN IF NOT EXISTS "locked_until" timestamp;
