-- Remote infra (edge / mail container) update tracking.
--
-- When the control plane's APP_VERSION moves forward, the edge/mail containers
-- already deployed on remote servers stay on their old image tag. Two additions
-- drive the "monitor → advise → apply" loop for that drift:
--
--   instance_settings.auto_update_infra / last_seen_version — the instance-wide
--     auto-update toggle and the version the infra reconcile last ran for (so the
--     boot hook fires exactly once per upgrade). Both additive: the boolean
--     carries a DEFAULT, last_seen_version is nullable.
--
--   server_container_status — the container sibling of server_module_status.
--     One row per (server, component); "behind" is a plain tag comparison
--     (running image ref != pinned image ref), since infra images are pinned to
--     APP_VERSION. Mirrors the module table's org+behind index and unique key.
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "auto_update_infra" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "instance_settings" ADD COLUMN IF NOT EXISTS "last_seen_version" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "server_container_status" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text REFERENCES "organization"("id") ON DELETE CASCADE,
  "server_id" text NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "component" text NOT NULL,
  "running_label" text,
  "pinned_label" text,
  "running_version" text,
  "pinned_version" text,
  "behind" boolean DEFAULT false NOT NULL,
  "latest_in_progress" boolean DEFAULT false NOT NULL,
  "detail" jsonb,
  "checked_at" timestamp DEFAULT now() NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_server_container_status"
  ON "server_container_status" ("server_id", "component");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_server_container_status_org_behind"
  ON "server_container_status" ("organization_id", "behind");
