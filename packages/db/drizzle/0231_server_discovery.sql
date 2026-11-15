CREATE TABLE IF NOT EXISTS "discovery_settings" (
  "server_id" text PRIMARY KEY NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "enabled" boolean DEFAULT false NOT NULL,
  "workspace_id" text REFERENCES "cloud_workspace"("id") ON DELETE SET NULL,
  "sweep_interval_seconds" integer DEFAULT 60 NOT NULL,
  "last_scan_at" timestamp with time zone,
  "last_scan_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discovery_binding" (
  "id" text PRIMARY KEY NOT NULL DEFAULT 'dsb_' || gen_random_uuid()::text,
  "server_id" text NOT NULL REFERENCES "servers"("id") ON DELETE CASCADE,
  "service_key" text NOT NULL,
  "compose_project" text,
  "compose_service" text,
  "hostname" text NOT NULL,
  "port" integer NOT NULL,
  "network_name" text,
  "network_id" text,
  "config_hash" text NOT NULL,
  "upstream_strategy" text,
  "host_port" integer,
  "host_ip" text,
  "container_id" text,
  "container_name" text,
  "ip_address" text,
  "container_running" boolean DEFAULT false NOT NULL,
  "observation_status" text DEFAULT 'observed' NOT NULL,
  "last_observed_at" timestamp with time zone,
  "apply_state" text DEFAULT 'pending' NOT NULL,
  "desired_generation" integer DEFAULT 0 NOT NULL,
  "applied_generation" integer DEFAULT 0 NOT NULL,
  "apply_error" text,
  "apply_attempts" integer DEFAULT 0 NOT NULL,
  "next_apply_at" timestamp with time zone,
  "withdrawal_pending" boolean DEFAULT false NOT NULL,
  "suppressed" boolean DEFAULT false NOT NULL,
  "suppressed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "discovery_binding_observation_status_check" CHECK ("observation_status" IN ('observed', 'missing', 'error', 'invalid')),
  CONSTRAINT "discovery_binding_upstream_strategy_check" CHECK ("upstream_strategy" IN ('network-ip', 'published-port')),
  CONSTRAINT "discovery_binding_apply_state_check" CHECK ("apply_state" IN ('pending', 'applied', 'error', 'blocked'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_discovery_binding_identity" ON "discovery_binding" ("server_id","service_key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_discovery_binding_server" ON "discovery_binding" ("server_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_discovery_binding_apply" ON "discovery_binding" ("server_id","apply_state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_discovery_binding_hostname" ON "discovery_binding" ("server_id","hostname");
--> statement-breakpoint
ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "server_id" text REFERENCES "servers"("id") ON DELETE CASCADE;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_domain_server" ON "domain" ("server_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_domain_server_hostname" ON "domain" ("server_id","hostname");
