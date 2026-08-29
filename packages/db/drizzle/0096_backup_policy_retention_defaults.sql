-- Turn retention on for policies that never said anything about it.
--
-- `retain_count` and `retain_days` were the only two fields on the policy
-- insert with neither an API default nor a column default, so every policy
-- created through the API or MCP stored NULL for both. `prunePolicy`
-- short-circuits on "no retention configured", so retention silently never ran
-- for those policies and their runs accumulated until the destination filled.
-- The dashboard's form defaults to 7, so a human creating a policy in the UI
-- got retention and the same policy created over the API did not.
--
-- 7 = the dashboard's own default (PolicyEditor), now shared as
-- DEFAULT_RETAIN_COUNT so the column, the API fallback, and the form agree.
--
-- The backfill is what actually fixes instances running today, and it is
-- narrowed to rows where BOTH fields are null: a policy with only `retain_days`
-- set has retention configured deliberately, and writing a count there would
-- silently tighten a window the operator chose.
ALTER TABLE "backup_policy" ALTER COLUMN "retain_count" SET DEFAULT 7;
--> statement-breakpoint
UPDATE "backup_policy" SET "retain_count" = 7 WHERE "retain_count" IS NULL AND "retain_days" IS NULL;
