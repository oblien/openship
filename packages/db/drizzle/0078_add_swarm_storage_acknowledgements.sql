ALTER TABLE "swarm_stack"
  ADD COLUMN IF NOT EXISTS "storage_acknowledgements" jsonb DEFAULT '[]'::jsonb NOT NULL;
