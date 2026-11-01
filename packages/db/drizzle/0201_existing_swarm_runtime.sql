-- External Swarm clusters retain their own network. Existing K3s rows keep
-- their network references and deferred membership foreign keys unchanged.
ALTER TABLE "compute_cluster" ALTER COLUMN "network_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "compute_cluster_member" ALTER COLUMN "network_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "cluster_runtime" DROP CONSTRAINT "cluster_runtime_provider_check";
--> statement-breakpoint
ALTER TABLE "cluster_runtime" ADD CONSTRAINT "cluster_runtime_provider_check" CHECK ("provider" IN ('k3s', 'swarm'));
--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_runtime_swarm_identity_idx" ON "cluster_runtime" ("organization_id", ("plan"->>'clusterUid')) WHERE "provider" = 'swarm';
--> statement-breakpoint
-- MATCH SIMPLE foreign keys skip NULL. Keep the existing deferred membership
-- invariant when external clusters legitimately have no Openship network.
CREATE FUNCTION openship_check_compute_network() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected_cluster text;
BEGIN
  IF TG_TABLE_NAME = 'compute_cluster' THEN affected_cluster := NEW.id;
  ELSE affected_cluster := NEW.cluster_id;
  END IF;
  IF EXISTS (
    SELECT 1 FROM compute_cluster c JOIN compute_cluster_member m ON m.cluster_id = c.id
    WHERE c.id = affected_cluster AND m.network_id IS DISTINCT FROM c.network_id
  ) THEN
    RAISE EXCEPTION 'Compute cluster members must use the cluster network' USING ERRCODE = '23503';
  END IF;
  RETURN NULL;
END;
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER compute_cluster_network_consistency
AFTER INSERT OR UPDATE ON compute_cluster DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION openship_check_compute_network();
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER compute_cluster_member_network_consistency
AFTER INSERT OR UPDATE ON compute_cluster_member DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION openship_check_compute_network();
