CREATE TABLE "server_cluster" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "name" text NOT NULL, "location" text, "revision" integer DEFAULT 1 NOT NULL,
  "request_id" text NOT NULL, "input_hash" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL, "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "server_cluster_request_idx" ON "server_cluster" ("organization_id", "request_id");
--> statement-breakpoint
CREATE TABLE "cluster_network" (
  "id" text PRIMARY KEY NOT NULL,
  "cluster_id" text NOT NULL REFERENCES "server_cluster"("id") ON DELETE CASCADE,
  "mode" text NOT NULL, "cidrs" jsonb NOT NULL, "mtu" integer NOT NULL, "probe_port" integer NOT NULL,
  "ownership" text DEFAULT 'external' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_network_cluster_idx" ON "cluster_network" ("cluster_id");
--> statement-breakpoint
CREATE TABLE "cluster_member" (
  "id" text PRIMARY KEY NOT NULL,
  "cluster_id" text NOT NULL REFERENCES "server_cluster"("id") ON DELETE CASCADE,
  "server_id" text NOT NULL REFERENCES "servers"("id") ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  "host_identity" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_member_server_idx" ON "cluster_member" ("server_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_member_host_idx" ON "cluster_member" ("host_identity") WHERE "host_identity" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "cluster_member_cluster_idx" ON "cluster_member" ("cluster_id");
--> statement-breakpoint
CREATE TABLE "server_network_attachment" (
  "id" text PRIMARY KEY NOT NULL,
  "network_id" text NOT NULL REFERENCES "cluster_network"("id") ON DELETE CASCADE,
  "server_id" text NOT NULL REFERENCES "servers"("id") ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  "provider_id" text NOT NULL, "private_ip" text NOT NULL, "interface_name" text, "network_ref" text
);
--> statement-breakpoint
CREATE UNIQUE INDEX "server_network_attachment_server_idx" ON "server_network_attachment" ("network_id", "server_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "server_network_attachment_address_idx" ON "server_network_attachment" ("network_id", "private_ip");
--> statement-breakpoint
CREATE TABLE "cluster_verification" (
  "id" text PRIMARY KEY NOT NULL,
  "cluster_id" text NOT NULL REFERENCES "server_cluster"("id") ON DELETE CASCADE,
  "revision" integer NOT NULL, "status" text NOT NULL, "report" jsonb NOT NULL, "error" text,
  "created_by" text NOT NULL, "started_at" timestamp DEFAULT now() NOT NULL,
  "finished_at" timestamp, "expires_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cluster_verification_cluster_idx" ON "cluster_verification" ("cluster_id", "started_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "cluster_verification_active_idx" ON "cluster_verification" ("cluster_id") WHERE "status" = 'running';
