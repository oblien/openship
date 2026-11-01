-- Local development installs may already have these tables from the earlier
-- journal. Preserve their authority and credentials when applying the merged chain.
CREATE TABLE IF NOT EXISTS "instance_controller" (
  "id" text PRIMARY KEY DEFAULT 'local' NOT NULL,
  "installation_id" text NOT NULL UNIQUE,
  "role" text DEFAULT 'active' NOT NULL,
  "handoff_id" text,
  "revision" integer DEFAULT 0 NOT NULL,
  "connection" text,
  "environment" text,
  "desktop_user_id" text,
  "project_id" text,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "instance_controller_singleton" CHECK ("id" = 'local'),
  CONSTRAINT "instance_controller_role" CHECK ("role" IN ('active','quiescing','frozen','receiving','prepared','retired','connected'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "instance_handoff" (
  "id" text PRIMARY KEY NOT NULL,
  "direction" text NOT NULL,
  "owner_user_id" text NOT NULL,
  "token_hash" text NOT NULL,
  "secrets" text NOT NULL,
  "status" text DEFAULT 'offered' NOT NULL,
  "manifest" jsonb,
  "recovery" jsonb,
  "provisioning" jsonb,
  "peer_origin" text,
  "peer_id" text,
  "result" text,
  "error" text,
  "expires_at" timestamp NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "instance_handoff_direction" CHECK ("direction" IN ('source','target')),
  CONSTRAINT "instance_handoff_status" CHECK ("status" IN ('offered','frozen','copying','prepared','retired','complete','aborted'))
);
