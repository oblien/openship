CREATE UNIQUE INDEX "uq_credential_org_id" ON "credential" ("organization_id","id");
--> statement-breakpoint
ALTER TABLE "servers"
  ADD COLUMN "oblien_credential_id" text,
  ADD COLUMN "oblien_vm_id" text;
--> statement-breakpoint
ALTER TABLE "servers"
  ADD CONSTRAINT "servers_oblien_credential_owner_fk" FOREIGN KEY ("organization_id","oblien_credential_id")
    REFERENCES "credential" ("organization_id","id") ON DELETE RESTRICT,
  ADD CONSTRAINT "servers_oblien_binding_check" CHECK (
    (oblien_credential_id IS NULL AND oblien_vm_id IS NULL) OR
    (oblien_credential_id IS NOT NULL AND oblien_vm_id IS NOT NULL AND organization_id IS NOT NULL
     AND workspace_id IS NULL AND purpose='deployment' AND NOT is_local AND ssh_host IS NULL
     AND ssh_password IS NULL AND ssh_key_path IS NULL AND ssh_private_key IS NULL
     AND ssh_key_passphrase IS NULL AND ssh_jump_host IS NULL AND ssh_args IS NULL)),
  DROP CONSTRAINT "servers_connection_check",
  ADD CONSTRAINT "servers_connection_check" CHECK (
    oblien_credential_id IS NOT NULL OR (workspace_id IS NULL AND ssh_host IS NOT NULL)
    OR (workspace_id IS NOT NULL AND organization_id IS NOT NULL AND NOT is_local AND ssh_host IS NULL
      AND ssh_password IS NULL AND ssh_key_path IS NULL AND ssh_private_key IS NULL
      AND ssh_key_passphrase IS NULL AND ssh_jump_host IS NULL AND ssh_args IS NULL));
--> statement-breakpoint
CREATE UNIQUE INDEX "servers_org_oblien_vm" ON "servers" ("organization_id","oblien_vm_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "servers_oblien_credential" ON "servers" ("oblien_credential_id") WHERE "oblien_credential_id" IS NOT NULL;
