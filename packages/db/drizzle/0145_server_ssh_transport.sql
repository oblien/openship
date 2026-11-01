ALTER TABLE "servers" ADD COLUMN "ssh_transport" text DEFAULT 'direct' NOT NULL;
--> statement-breakpoint
ALTER TABLE "servers" ADD CONSTRAINT "servers_ssh_transport_check" CHECK ("ssh_transport" IN ('direct', 'cloudflare'));
