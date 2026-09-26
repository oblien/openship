ALTER TABLE "domain" ADD COLUMN IF NOT EXISTS "ssl_dns_mode" text NOT NULL DEFAULT 'automatic';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "acme_account" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "directory_url" text NOT NULL,
  "key_enc" text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_acme_account_org_directory" ON "acme_account" ("organization_id", "directory_url");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "domain_dns_challenge" (
  "domain_id" text PRIMARY KEY NOT NULL REFERENCES "domain"("id") ON DELETE CASCADE,
  "id" text NOT NULL,
  "mode" text NOT NULL,
  "status" text NOT NULL,
  "record_name" text,
  "record_value" text,
  "account_id" text REFERENCES "acme_account"("id"),
  "order_enc" text,
  "lease_id" text,
  "lease_expires_at" timestamp,
  "expires_at" timestamp NOT NULL,
  "logs" text NOT NULL DEFAULT '',
  "error" text,
  "created_at" timestamp NOT NULL DEFAULT now(),
  "updated_at" timestamp NOT NULL DEFAULT now()
);
