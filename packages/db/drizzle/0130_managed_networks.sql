ALTER TABLE "cluster_network" ADD COLUMN "managed_id" text;
--> statement-breakpoint
ALTER TABLE "cluster_network" ADD COLUMN "interface_name" text;
--> statement-breakpoint
ALTER TABLE "server_network_attachment" ADD COLUMN "endpoint" text;
--> statement-breakpoint
ALTER TABLE "server_network_attachment" ADD COLUMN "listen_port" integer;
--> statement-breakpoint
ALTER TABLE "server_network_attachment" ADD COLUMN "public_key" text;
--> statement-breakpoint
CREATE TABLE "managed_network_operation" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "cluster_id" text NOT NULL, "input_hash" text NOT NULL, "plan_hash" text NOT NULL,
  "plan" jsonb NOT NULL, "status" text NOT NULL, "hosts" jsonb NOT NULL,
  "report" jsonb, "error" text, "created_by" text NOT NULL, "generation" integer DEFAULT 0 NOT NULL,
  "lease_expires_at" timestamp, "created_at" timestamp DEFAULT now() NOT NULL, "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "managed_network_operation_cluster_idx" ON "managed_network_operation" ("organization_id", "cluster_id", "created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "managed_network_operation_active_idx" ON "managed_network_operation" ("cluster_id")
  WHERE "status" IN ('applying', 'verifying', 'committing', 'rolling_back', 'interrupted', 'needs_attention');
--> statement-breakpoint
CREATE TABLE "managed_network_claim" (
  "server_id" text PRIMARY KEY NOT NULL REFERENCES "servers"("id") ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  "host_identity" text NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "cluster_id" text NOT NULL,
  "operation_id" text NOT NULL REFERENCES "managed_network_operation"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX "managed_network_claim_host_idx" ON "managed_network_claim" ("host_identity");
