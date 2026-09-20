-- Persist every loopback publish owned by a service deployment.
--
-- `host_port` only remembers the primary route. A stopped multi-port service can
-- therefore leave a secondary OpenResty vhost pointing at a port the allocator
-- believes is free. Keep the scalar for compatibility and add the complete
-- container-port -> host-port map used by routing and collision prevention.
ALTER TABLE "service_deployment"
  ADD COLUMN IF NOT EXISTS "host_ports" jsonb;
--> statement-breakpoint

-- The legacy scalar's container-side port is unknown. Preserve it under a
-- non-numeric key: allocation reads every value, while routing deliberately
-- consumes numeric container-port keys only and continues using `host_port` as
-- its legacy fallback.
UPDATE "service_deployment"
SET "host_ports" = jsonb_build_object('__legacy__', "host_port")
WHERE "host_port" IS NOT NULL
  AND "host_ports" IS NULL;
