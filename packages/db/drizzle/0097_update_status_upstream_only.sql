-- update_status becomes an UPSTREAM-only cache.
--
-- The table used to cache both halves of the drift answer: what the source offers
-- (upstream) and what is currently deployed. Only the first half is expensive and
-- poll-only. The second half — `behind`, `latest_in_progress`, `current_label` —
-- is derived from the project's ACTIVE deployment, which seven separate code paths
-- write (deploy success, rollback, reconcile, activate, clear, self-deploy,
-- migrate). Caching it meant each of those needed an invalidation hook; only one
-- ever had it, so rows froze mid-window and the dashboard advertised updates for
-- commits the operator had already shipped.
--
-- Those columns are now computed on read, so keeping them would leave a copy that
-- looks authoritative while describing a superseded release. `latest_label` goes
-- too: it's rendered from `detail` alongside the live current label, in one code
-- path, so the two can never disagree.
--
-- Existing rows keep `detail`, but rows written before this migration carry only
-- the 7-char sha prefix in the dropped `latest_label` — never a full `latestSha`
-- in `detail` — so a commit row cannot be compared until it is re-polled. Clear
-- them and let `updates:scan` (or the dashboard's explicit check) repopulate;
-- until then those projects simply report no update, which is the conservative
-- direction.
DELETE FROM "update_status";
--> statement-breakpoint
DROP INDEX IF EXISTS "idx_update_status_org_behind";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_update_status_org" ON "update_status" ("organization_id");
--> statement-breakpoint
ALTER TABLE "update_status" DROP COLUMN IF EXISTS "behind";
--> statement-breakpoint
ALTER TABLE "update_status" DROP COLUMN IF EXISTS "latest_in_progress";
--> statement-breakpoint
ALTER TABLE "update_status" DROP COLUMN IF EXISTS "current_label";
--> statement-breakpoint
ALTER TABLE "update_status" DROP COLUMN IF EXISTS "latest_label";
