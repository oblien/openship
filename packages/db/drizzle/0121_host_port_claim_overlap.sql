-- A routed workload may need a new loopback port while its previous route is
-- still live. Keep both claims through that make-before-break window; the
-- route-aware convergence pass removes the old claim only after a fresh edge
-- scan proves no vhost still dials it. The target/port unique index remains the
-- collision authority, so this does not permit two workloads to share a port.
DROP INDEX IF EXISTS "uq_host_port_claim_target_owner";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_host_port_claim_target_owner"
  ON "host_port_claim" (
    "target_key",
    "project_id",
    COALESCE("service_id", ''),
    COALESCE("container_port", 0)
  );
