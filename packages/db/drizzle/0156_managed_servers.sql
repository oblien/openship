ALTER TABLE "servers" ADD COLUMN "workspace_id" text;
--> statement-breakpoint
ALTER TABLE "servers" ALTER COLUMN "ssh_host" DROP NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "servers_workspace_unique" ON "servers" ("workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "servers_workspace_owner_unique" ON "servers" ("id", "workspace_id", "organization_id");
--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_workspace_owner_fk" FOREIGN KEY ("workspace_id", "organization_id") REFERENCES "cloud_workspace" ("id", "organization_id") ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_connection_check" CHECK (
  ("workspace_id" IS NULL AND "ssh_host" IS NOT NULL)
  OR ("workspace_id" IS NOT NULL AND "organization_id" IS NOT NULL
    AND NOT "is_local" AND "ssh_host" IS NULL
    AND "ssh_password" IS NULL AND "ssh_key_path" IS NULL
    AND "ssh_private_key" IS NULL AND "ssh_key_passphrase" IS NULL
    AND "ssh_jump_host" IS NULL AND "ssh_args" IS NULL)
);
--> statement-breakpoint
-- Register execution identities for the workspaces created by the preceding
-- migration/version. This does not provision, resize or move a provider VM.
INSERT INTO "servers" ("id", "organization_id", "workspace_id", "name", "ssh_port", "ssh_user")
SELECT gen_random_uuid()::text, "organization_id", "id", "name", NULL, NULL
FROM "cloud_workspace";
--> statement-breakpoint
ALTER TABLE "project" DROP CONSTRAINT IF EXISTS "project_workspace_target_check";
--> statement-breakpoint
UPDATE "project" AS p SET "server_id" = s."id"
FROM "servers" AS s WHERE p."workspace_id" = s."workspace_id";
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_workspace_target_check" CHECK ("workspace_id" IS NULL OR ("server_id" IS NOT NULL AND "cluster_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_server_workspace_fk" FOREIGN KEY ("server_id", "workspace_id", "organization_id") REFERENCES "servers" ("id", "workspace_id", "organization_id") ON DELETE RESTRICT;
--> statement-breakpoint
-- The server is the execution identity. Keep the indexed billing-owner column
-- derived from it so a missing/stale caller field cannot detach a shared project
-- from the workspace's quota, deletion and subscription checks.
CREATE FUNCTION "openship_project_server_owner"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_workspace text; owner_org text;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."workspace_id" IS NOT NULL AND
    (NEW."server_id" IS DISTINCT FROM OLD."server_id" OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id") THEN
    RAISE EXCEPTION 'Moving a managed project requires an explicit migration';
  END IF;
  IF NEW."server_id" IS NOT NULL THEN
    SELECT "workspace_id", "organization_id" INTO owner_workspace, owner_org
    FROM "servers" WHERE "id" = NEW."server_id" FOR KEY SHARE;
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
--> statement-breakpoint
CREATE TRIGGER "project_server_owner" BEFORE INSERT OR UPDATE OF "server_id", "workspace_id", "organization_id" ON "project"
FOR EACH ROW EXECUTE FUNCTION "openship_project_server_owner"();
--> statement-breakpoint
CREATE FUNCTION "openship_managed_server_owner"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (OLD."workspace_id" IS NOT NULL OR NEW."workspace_id" IS NOT NULL) AND
    (NEW."workspace_id" IS DISTINCT FROM OLD."workspace_id" OR NEW."organization_id" IS DISTINCT FROM OLD."organization_id") THEN
    RAISE EXCEPTION 'Managed server ownership cannot be reassigned';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "managed_server_owner" BEFORE UPDATE OF "workspace_id", "organization_id" ON "servers"
FOR EACH ROW EXECUTE FUNCTION "openship_managed_server_owner"();
