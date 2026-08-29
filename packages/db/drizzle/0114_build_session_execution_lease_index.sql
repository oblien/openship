-- Project deletion and deployment admission query the durable build-worker
-- lease, including after the deployment status has already become terminal.
CREATE INDEX "idx_build_session_live_project_deployment"
  ON "build_session" ("project_id", "deployment_id")
  WHERE "started_at" IS NOT NULL
    AND "finished_at" IS NULL;
