CREATE UNIQUE INDEX IF NOT EXISTS "uq_swarm_stack_cluster_name_global"
  ON "swarm_stack" USING btree ("cluster_id", "stack_name");
