ALTER TABLE "servers" ADD COLUMN "purpose" text DEFAULT 'deployment' NOT NULL;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN "ssh_host_key" text;
--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_purpose_check"
  CHECK ("purpose" IN ('deployment', 'migration_source'));
--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_migration_source_check" CHECK (
  "purpose" <> 'migration_source' OR (
    "organization_id" IS NOT NULL AND "workspace_id" IS NULL AND NOT "is_local"
    AND "ssh_host" IS NOT NULL AND "ssh_host_key" IS NOT NULL
    AND "ssh_transport" = 'direct' AND "ssh_key_path" IS NULL
    AND "ssh_jump_host" IS NULL AND "ssh_args" IS NULL
    AND (("ssh_auth_method" = 'password' AND "ssh_password" IS NOT NULL)
      OR ("ssh_auth_method" = 'key' AND "ssh_private_key" IS NOT NULL))
  )
);
