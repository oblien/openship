-- Early installs applied 0128 before uses_private_network was added to its SQL.
-- A new migration repairs those databases while preserving existing flag values.
ALTER TABLE "project_connection" ADD COLUMN IF NOT EXISTS "uses_private_network" boolean DEFAULT true NOT NULL;
