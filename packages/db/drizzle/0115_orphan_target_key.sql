-- Keep deferred cleanup ordered by immutable physical target identity. Server
-- rows are aliases and two aliases may reach the same bind namespace.
ALTER TABLE "orphaned_resource" ADD COLUMN "target_key" text;
