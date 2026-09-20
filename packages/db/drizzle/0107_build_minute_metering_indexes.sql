-- Indexes for the build-minute allowance query.
--
-- `sumBuildMillisForOrg` joins build_session → deployment, filters on
-- deployment.organization_id and windows on build_session.started_at. It used to
-- run only on the billing page (once, on demand); it now runs on the plan gate in
-- `createQueuedDeployment`, i.e. on every deploy. Neither side of that join had a
-- supporting index — build_session carried only its primary key and
-- deployment.organization_id had none — so the query was a double sequential scan
-- whose cost grows with TOTAL deployment history across all orgs, not with the
-- org being checked.
--
-- (domain.project_id, which the free-subdomain count joins on, is already covered
-- by idx_domain_project.)
CREATE INDEX IF NOT EXISTS "idx_build_session_started_at"
  ON "build_session" ("started_at");--> statement-breakpoint

-- Org scoping for the same join. Also serves the org-wide deployment listings,
-- which had been scanning for the same reason.
CREATE INDEX IF NOT EXISTS "idx_deployment_org"
  ON "deployment" ("organization_id");
