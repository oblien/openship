CREATE TABLE "cloud_docker_workspace" (
  "project_id" text PRIMARY KEY NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "namespace" text NOT NULL,
  "provision_key" text NOT NULL,
  "workspace_id" text,
  "image" text NOT NULL,
  "resources" jsonb NOT NULL,
  "state" text DEFAULT 'provisioning' NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "cloud_docker_workspace_state_check" CHECK ("state" IN ('provisioning', 'ready'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cloud_docker_workspace_id" ON "cloud_docker_workspace" ("workspace_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "uq_cloud_docker_provision_key" ON "cloud_docker_workspace" ("provision_key");
