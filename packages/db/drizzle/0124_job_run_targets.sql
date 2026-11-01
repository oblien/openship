-- Keep execution targets after a job is edited or deleted. Never infer historical
-- multi-server targets from the current job: that would change who can read output.
ALTER TABLE "job_run" ADD COLUMN "server_ids" text[];
