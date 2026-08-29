-- Separate a backup run's durable worker liveness from its public FSM outcome.
-- A timeout may record server_error while the original worker is still unwinding;
-- project deletion must keep waiting until that worker's outermost finally closes
-- this lease.
ALTER TABLE "backup_run"
  ADD COLUMN "execution_started_at" timestamp,
  ADD COLUMN "execution_finished_at" timestamp;
--> statement-breakpoint
CREATE INDEX "idx_backup_run_execution_in_flight"
  ON "backup_run" ("project_id")
  WHERE "execution_started_at" IS NOT NULL
    AND "execution_finished_at" IS NULL;
