-- A project-default policy creates one child run per enabled service. Persist
-- the enqueue identity so read models can aggregate exact siblings without
-- co-mingling unrelated triggers that happened close together.
ALTER TABLE "backup_run" ADD COLUMN "batch_id" text;
--> statement-breakpoint
CREATE INDEX "idx_backup_run_policy_batch"
  ON "backup_run" ("policy_id", "batch_id")
  WHERE "batch_id" IS NOT NULL AND "deleted_at" IS NULL;
