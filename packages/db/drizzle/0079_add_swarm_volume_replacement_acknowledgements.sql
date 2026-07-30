ALTER TABLE "swarm_stack"
  ADD COLUMN IF NOT EXISTS "volume_replacement_acknowledgements" jsonb DEFAULT '[]'::jsonb NOT NULL;
