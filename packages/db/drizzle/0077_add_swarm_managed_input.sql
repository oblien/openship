CREATE TABLE IF NOT EXISTS "swarm_managed_input" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE cascade,
  "kind" text NOT NULL,
  "logical_name" text NOT NULL,
  "value_enc" text NOT NULL,
  "created_by_user_id" text,
  "updated_by_user_id" text,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_swarm_managed_input_project_kind_logical" ON "swarm_managed_input" USING btree ("project_id","kind","logical_name");
CREATE INDEX IF NOT EXISTS "idx_swarm_managed_input_project" ON "swarm_managed_input" USING btree ("project_id");
