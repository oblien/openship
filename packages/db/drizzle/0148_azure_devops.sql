-- Azure DevOps import: 3-level org/project/repo + per-organization PAT
-- connections + Service Hook subscription id.
--
-- git_project is the Azure "project" (middle segment). Null on GitHub rows.
-- webhook_external_id holds Azure Service Hook subscription GUIDs; GitHub
-- continues to use integer webhook_id.
-- azure_connection stores one PAT per (organization, Azure DevOps org) pair,
-- sealed the same way as other credential envelopes. Never stored inside
-- git_url. Per-tenant by design: rows cascade with the owning organization.
CREATE TABLE IF NOT EXISTS "azure_connection" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"ado_org" text NOT NULL,
	"pat_encrypted" text NOT NULL,
	"pat_set_at" timestamp DEFAULT now() NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_error" text,
	"last_verified_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "azure_connection" ADD CONSTRAINT "azure_connection_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_azure_connection_org_ado" ON "azure_connection" USING btree ("organization_id","ado_org");
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "git_project" text;
--> statement-breakpoint
ALTER TABLE "project" ADD COLUMN IF NOT EXISTS "webhook_external_id" text;
