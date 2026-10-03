-- A project move may rebind its own project and restore the saved source. The
-- transaction must name that run explicitly; ordinary project edits retain the
-- managed-server ownership guard, even while a migration is in progress.
CREATE OR REPLACE FUNCTION "openship_project_server_owner"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_workspace text; owner_org text; server_purpose text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."workspace_id" IS NOT NULL AND
    (NEW."server_id" IS DISTINCT FROM OLD."server_id" OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id") THEN
    IF NEW."organization_id" IS DISTINCT FROM OLD."organization_id" OR NOT EXISTS (
      SELECT 1 FROM "docker_migration_run" m
      WHERE m."id" = current_setting('openship.migration_id', true)
        AND m."organization_id" = OLD."organization_id" AND m."project_id" = OLD."id"
        AND m."mode" = 'project_move' AND m."finished_at" IS NULL
        AND m."recovery" #>> '{sourceProject,serverId}' = m."source_server_id"
        AND (
          (m."status" = 'adopting' AND OLD."server_id" = m."source_server_id" AND NEW."server_id" = m."target_server_id")
          OR (m."status" IN ('adopting', 'moving_data', 'deploying', 'verifying', 'awaiting_cutover', 'partial')
            AND OLD."server_id" = m."target_server_id" AND NEW."server_id" = m."source_server_id")
        )
    ) THEN
      RAISE EXCEPTION 'Moving a managed project requires an explicit migration';
    END IF;
  END IF;
  IF NEW."server_id" IS NOT NULL THEN
    SELECT "workspace_id", "organization_id", "purpose" INTO owner_workspace, owner_org, server_purpose
    FROM "servers" WHERE "id" = NEW."server_id" FOR KEY SHARE;
  END IF;
  IF server_purpose = 'migration_source' THEN
    RAISE EXCEPTION 'A migration source cannot be a project destination';
  END IF;
  IF owner_workspace IS NOT NULL THEN
    IF NEW."organization_id" IS DISTINCT FROM owner_org OR
      (NEW."workspace_id" IS NOT NULL AND NEW."workspace_id" IS DISTINCT FROM owner_workspace) THEN
      RAISE EXCEPTION 'Project and managed server have different owners';
    END IF;
    NEW."workspace_id" := owner_workspace;
  ELSIF NEW."workspace_id" IS NOT NULL THEN
    RAISE EXCEPTION 'A Cloud project requires its workspace managed server';
  END IF;
  RETURN NEW;
END;
$$;
