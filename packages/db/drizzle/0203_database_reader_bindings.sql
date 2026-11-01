-- Existing writer bindings and database identities remain unchanged.
ALTER TABLE "cluster_database" ADD COLUMN IF NOT EXISTS "read_env_key" text;
--> statement-breakpoint
ALTER TABLE "cluster_database" ADD COLUMN IF NOT EXISTS "read_env_value_encrypted" text;
