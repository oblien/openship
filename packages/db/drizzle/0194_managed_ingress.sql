CREATE TABLE "ingress_connection" (
 "id" text PRIMARY KEY NOT NULL,
 "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE RESTRICT,
 "server_id" text NOT NULL REFERENCES "servers"("id") ON DELETE RESTRICT,
 "credential_id" text NOT NULL REFERENCES "credential"("id") ON DELETE RESTRICT,
 "provider" text NOT NULL DEFAULT 'cloudflare',
 "account_id" text NOT NULL,
 "tunnel_id" text,
 "name" text NOT NULL,
 "managed_tunnel" boolean NOT NULL DEFAULT false,
 "connector" text NOT NULL,
 "edge_port" integer NOT NULL DEFAULT 80 CHECK (edge_port BETWEEN 1 AND 65535),
 "default_for_domains" boolean NOT NULL DEFAULT false,
 "default_access_policy_id" text,
 "status" text NOT NULL DEFAULT 'pending',
 "error" text,
 "attempts" integer NOT NULL DEFAULT 0,
 "next_attempt_at" timestamp NOT NULL DEFAULT now(),
 "created_at" timestamp NOT NULL DEFAULT now(),
 "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX "ingress_connection_due" ON "ingress_connection"("status", "next_attempt_at");
--> statement-breakpoint
CREATE UNIQUE INDEX "ingress_connection_server" ON "ingress_connection"("server_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "ingress_connection_tunnel" ON "ingress_connection"("account_id", "tunnel_id");
--> statement-breakpoint
CREATE TABLE "ingress_hostname" (
 "id" text PRIMARY KEY NOT NULL,
 "connection_id" text NOT NULL REFERENCES "ingress_connection"("id") ON DELETE RESTRICT,
 "domain_id" text REFERENCES "domain"("id") ON DELETE SET NULL,
 "hostname" text NOT NULL,
 "access_policy_id" text,
 "status" text NOT NULL DEFAULT 'pending',
 "phase" text NOT NULL DEFAULT 'access',
 "ownership" jsonb NOT NULL DEFAULT '{}',
 "error" text,
 "attempts" integer NOT NULL DEFAULT 0,
 "next_attempt_at" timestamp NOT NULL DEFAULT now(),
 "updated_at" timestamp NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ingress_hostname_domain" ON "ingress_hostname"("domain_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "ingress_hostname_host" ON "ingress_hostname"("connection_id", "hostname");
--> statement-breakpoint
CREATE INDEX "ingress_hostname_due" ON "ingress_hostname"("next_attempt_at");
