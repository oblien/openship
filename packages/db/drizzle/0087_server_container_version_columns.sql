-- Repair: add `server_container_status.running_version` / `pinned_version` on a
-- database that ran an earlier form of 0086.
--
-- 0086 was edited in place after it had already been applied: the version columns
-- were added to its CREATE TABLE, but that create is `IF NOT EXISTS`, so on any
-- database that had already run the older 0086 the table exists and the amended
-- create is a silent no-op — the columns never appear. drizzle's migrator then
-- refuses to re-run 0086 (its `when` equals the last-applied stamp, and the
-- comparison is strict `<`; see 0081_project_readiness_repair for the same trap),
-- so nothing else patches it either. Every `listByOrg` then dies with
-- `column "running_version" does not exist` (42703).
--
-- Idempotent and stamped after 0086, so it sorts as a fresh migration: a database
-- created cleanly gets the columns at 0086 and this is a no-op; a database that
-- ran the stale 0086 gets them here. Safe to keep in history permanently.
ALTER TABLE "server_container_status" ADD COLUMN IF NOT EXISTS "running_version" text;--> statement-breakpoint
ALTER TABLE "server_container_status" ADD COLUMN IF NOT EXISTS "pinned_version" text;
