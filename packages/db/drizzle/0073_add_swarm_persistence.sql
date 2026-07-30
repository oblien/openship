ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "orchestrator_mode" text DEFAULT 'standalone' NOT NULL;--> statement-breakpoint
ALTER TABLE "deployment" ADD COLUMN IF NOT EXISTS "runtime_ref" jsonb;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN IF NOT EXISTS "source_service_name" text;--> statement-breakpoint
ALTER TABLE "service" ADD COLUMN IF NOT EXISTS "swarm_projection" jsonb;--> statement-breakpoint
ALTER TABLE "service_deployment" ADD COLUMN IF NOT EXISTS "runtime_ref" jsonb;--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "swarm_stack" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "project_id" text NOT NULL,
  "manager_server_id" text,
  "cluster_id" text NOT NULL,
  "stack_name" text NOT NULL,
  "management_mode" text DEFAULT 'observe' NOT NULL,
  "source_kind" text DEFAULT 'inline' NOT NULL,
  "source_paths" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "source_path" text,
  "source_yaml_enc" text,
  "source_digest" text,
  "routing_mode" text DEFAULT 'external' NOT NULL,
  "registry_id" text,
  "prune" boolean DEFAULT false NOT NULL,
  "resolve_image" text DEFAULT 'changed' NOT NULL,
  "with_registry_auth" boolean DEFAULT false NOT NULL,
  "last_observed_digest" text,
  "last_applied_revision_id" text,
  "drift_status" text DEFAULT 'unknown' NOT NULL,
  "drift_details" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "observed_state" jsonb DEFAULT '{}'::jsonb,
  "last_observed_at" timestamp,
  "claimed_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "swarm_stack_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade,
  CONSTRAINT "swarm_stack_project_id_project_id_fk"
    FOREIGN KEY ("project_id") REFERENCES "project"("id") ON DELETE cascade,
  CONSTRAINT "swarm_stack_manager_server_id_servers_id_fk"
    FOREIGN KEY ("manager_server_id") REFERENCES "servers"("id") ON DELETE set null
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "swarm_stack_revision" (
  "id" text PRIMARY KEY NOT NULL,
  "stack_id" text NOT NULL,
  "revision" integer NOT NULL,
  "source_digest" text,
  "rendered_yaml_enc" text NOT NULL,
  "rendered_digest" text NOT NULL,
  "rendered_yaml_redacted" text,
  "override_yaml_redacted" text,
  "manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "service_images" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "service_refs" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "config_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "secret_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "apply_status" text DEFAULT 'previewed' NOT NULL,
  "apply_output" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_by_user_id" text,
  "applied_at" timestamp,
  "converged_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "swarm_stack_revision_stack_id_swarm_stack_id_fk"
    FOREIGN KEY ("stack_id") REFERENCES "swarm_stack"("id") ON DELETE cascade
);--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "container_registry" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL,
  "name" text NOT NULL,
  "registry_url" text NOT NULL,
  "repository_prefix" text,
  "username" text,
  "credentials_enc" text,
  "insecure" boolean DEFAULT false NOT NULL,
  "last_verified_at" timestamp,
  "last_verify_error" text,
  "metadata" jsonb DEFAULT '{}'::jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "container_registry_organization_id_organization_id_fk"
    FOREIGN KEY ("organization_id") REFERENCES "organization"("id") ON DELETE cascade
);--> statement-breakpoint

ALTER TABLE "swarm_stack"
  ADD CONSTRAINT "swarm_stack_registry_id_container_registry_id_fk"
  FOREIGN KEY ("registry_id") REFERENCES "container_registry"("id") ON DELETE set null;--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "uq_service_project_swarm_source"
  ON "service" USING btree ("project_id", "source_service_name")
  WHERE "source_service_name" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_swarm_stack_project" ON "swarm_stack" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_swarm_stack_cluster_name"
  ON "swarm_stack" USING btree ("organization_id", "cluster_id", "stack_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_swarm_stack_org_manager"
  ON "swarm_stack" USING btree ("organization_id", "manager_server_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_swarm_stack_observe"
  ON "swarm_stack" USING btree ("organization_id", "management_mode")
  WHERE "management_mode" = 'observe';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_swarm_stack_revision"
  ON "swarm_stack_revision" USING btree ("stack_id", "revision");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_swarm_stack_revision_stack_created"
  ON "swarm_stack_revision" USING btree ("stack_id", "created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_container_registry_org_name"
  ON "container_registry" USING btree ("organization_id", "name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_container_registry_org"
  ON "container_registry" USING btree ("organization_id");
