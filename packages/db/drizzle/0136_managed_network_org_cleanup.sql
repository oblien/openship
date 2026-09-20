-- Organization cascades must not erase the only recovery journal for network
-- state that still exists on customer hosts. Native networks are externally
-- owned and do not require an Openship cleanup transaction.
CREATE FUNCTION "openship_has_managed_network_state"(org_id text)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "server_cluster" c
    JOIN "cluster_network" n ON n."cluster_id" = c."id"
    WHERE c."organization_id" = org_id AND n."ownership" = 'openship'
  ) OR EXISTS (
    SELECT 1 FROM "managed_network_claim" WHERE "organization_id" = org_id
  );
$$;
--> statement-breakpoint
CREATE FUNCTION "openship_require_managed_network_cleanup"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF openship_has_managed_network_state(OLD."id") THEN
    RAISE EXCEPTION 'Remove managed cluster networks and complete network recovery before deleting this organization.'
      USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "organization_managed_network_cleanup"
BEFORE DELETE ON "organization"
FOR EACH ROW EXECUTE FUNCTION "openship_require_managed_network_cleanup"();
