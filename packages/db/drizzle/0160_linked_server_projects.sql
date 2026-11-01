ALTER TABLE "cloud_workspace" ADD COLUMN IF NOT EXISTS "linked_projects" jsonb NOT NULL DEFAULT '[]';
