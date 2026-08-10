-- Org-wide incident reads for the global issue tracker.
--
-- The existing indexes on this table are project-keyed (`idx_service_incident_project`)
-- or exist to enforce the one-open-incident invariant. Both are wrong shapes for the
-- new question: "every incident in THIS organization, newest first" — the Issues feed's
-- Open tab and its Resolved tab, which sorts org-wide across up to 30 days of retained
-- history. Without this the feed sequentially scans the whole table and filters, which
-- gets slower exactly as an instance accumulates the history that makes the tab useful.
--
-- Covers both scopes: server-scoped rows have `project_id IS NULL`, so a project-keyed
-- index can't serve them at all.
CREATE INDEX IF NOT EXISTS "idx_service_incident_org"
  ON "service_incident" ("organization_id", "opened_at" DESC);
