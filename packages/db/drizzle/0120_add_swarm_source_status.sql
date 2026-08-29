ALTER TABLE "swarm_stack" ADD COLUMN IF NOT EXISTS "source_status" text DEFAULT 'missing' NOT NULL;
