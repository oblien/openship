-- Preserve network IDs and operation journals. Serialized plans deliberately keep
-- their legacy clusterId field: changing approved payloads would invalidate hashes
-- and host rollback receipts. It now identifies the independent network.
ALTER TABLE "server_cluster" RENAME TO "private_network";
--> statement-breakpoint
ALTER TABLE "cluster_network" RENAME TO "private_network_config";
--> statement-breakpoint
ALTER TABLE "cluster_member" RENAME TO "network_member";
--> statement-breakpoint
ALTER TABLE "cluster_verification" RENAME TO "network_verification";
--> statement-breakpoint
ALTER TABLE "private_network_config" RENAME COLUMN "cluster_id" TO "network_id";
--> statement-breakpoint
ALTER TABLE "network_member" RENAME COLUMN "cluster_id" TO "network_id";
--> statement-breakpoint
ALTER TABLE "network_verification" RENAME COLUMN "cluster_id" TO "network_id";
--> statement-breakpoint
ALTER TABLE "managed_network_operation" RENAME COLUMN "cluster_id" TO "network_id";
--> statement-breakpoint
ALTER TABLE "managed_network_claim" RENAME COLUMN "cluster_id" TO "network_id";
--> statement-breakpoint
DROP INDEX "cluster_member_server_idx";
--> statement-breakpoint
DROP INDEX "cluster_member_host_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "network_member_server_idx" ON "network_member" ("network_id", "server_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "network_member_host_idx" ON "network_member" ("network_id", "host_identity") WHERE "host_identity" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "network_member_inventory_idx" ON "network_member" ("server_id");
--> statement-breakpoint
CREATE TABLE "compute_cluster" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "name" text NOT NULL, "location" text, "revision" integer NOT NULL DEFAULT 1,
  "network_id" text NOT NULL REFERENCES "private_network"("id") ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  "request_id" text NOT NULL, "input_hash" text NOT NULL,
  "created_at" timestamp NOT NULL DEFAULT now(), "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "compute_cluster_id_network_idx" ON "compute_cluster" ("id", "network_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "compute_cluster_request_idx" ON "compute_cluster" ("organization_id", "request_id");
--> statement-breakpoint
CREATE INDEX "compute_cluster_network_idx" ON "compute_cluster" ("network_id");
--> statement-breakpoint
CREATE TABLE "compute_cluster_member" (
  "id" text PRIMARY KEY NOT NULL,
  "cluster_id" text NOT NULL REFERENCES "compute_cluster"("id") ON DELETE CASCADE,
  "network_id" text NOT NULL,
  "server_id" text NOT NULL REFERENCES "servers"("id") ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY ("cluster_id", "network_id") REFERENCES "compute_cluster"("id", "network_id") ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY ("network_id", "server_id") REFERENCES "network_member"("network_id", "server_id") ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED
);
--> statement-breakpoint
CREATE UNIQUE INDEX "compute_cluster_member_server_idx" ON "compute_cluster_member" ("server_id");
--> statement-breakpoint
CREATE INDEX "compute_cluster_member_cluster_idx" ON "compute_cluster_member" ("cluster_id");
--> statement-breakpoint
-- Established groups remain available as compute clusters. In-flight and failed
-- first setups remain standalone networks so their existing rollback can finish.
INSERT INTO "compute_cluster" ("id", "organization_id", "name", "location", "network_id", "request_id", "input_hash", "created_at", "updated_at")
SELECT n."id", n."organization_id", n."name", n."location", n."id", n."request_id", 'migrated:' || n."input_hash", n."created_at", n."updated_at"
FROM "private_network" n JOIN "private_network_config" c ON c."network_id" = n."id"
WHERE (c."ownership" = 'external' OR n."revision" > 1 OR EXISTS (
  SELECT 1 FROM "managed_network_operation" o
  WHERE o."network_id" = n."id" AND o."status" = 'succeeded' AND o."plan"->>'intent' = 'configure'
))
AND NOT EXISTS (SELECT 1 FROM "managed_network_operation" o WHERE o."network_id" = n."id" AND o."status" IN ('applying', 'verifying', 'committing', 'rolling_back', 'interrupted', 'needs_attention'));
--> statement-breakpoint
INSERT INTO "compute_cluster_member" ("id", "cluster_id", "network_id", "server_id")
SELECT m."id", m."network_id", m."network_id", m."server_id"
FROM "network_member" m JOIN "compute_cluster" c ON c."id" = m."network_id";
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "openship_has_managed_network_state"(org_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "private_network" n
    JOIN "private_network_config" c ON c."network_id" = n."id"
    WHERE n."organization_id" = org_id AND c."ownership" = 'openship'
  ) OR EXISTS (
    SELECT 1 FROM "managed_network_claim" WHERE "organization_id" = org_id
  );
$$;
