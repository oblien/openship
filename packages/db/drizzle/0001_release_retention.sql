ALTER TABLE "instance_settings"
ADD COLUMN "default_rollback_window" integer NOT NULL DEFAULT 5;

ALTER TABLE "project"
ADD COLUMN "rollback_window" integer;