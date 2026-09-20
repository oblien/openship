-- A parked migration can be resumed/cut over by any API replica. Persist the
-- winning callback's liveness separately from its public FSM status so project
-- deletion never mistakes an early terminal outcome for a stopped worker.
ALTER TABLE "docker_migration_run"
  ADD COLUMN "execution_started_at" timestamp,
  ADD COLUMN "execution_finished_at" timestamp;
--> statement-breakpoint
CREATE INDEX "idx_docker_migration_execution_in_flight"
  ON "docker_migration_run" ("project_id")
  WHERE "execution_started_at" IS NOT NULL
    AND "execution_finished_at" IS NULL;
