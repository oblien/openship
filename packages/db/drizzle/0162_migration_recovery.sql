ALTER TABLE "docker_migration_run" ADD COLUMN "recovery" jsonb DEFAULT '{}'::jsonb NOT NULL;
