CREATE TABLE IF NOT EXISTS "managed_mail_service" (
  "id" text PRIMARY KEY,
  "organization_id" text UNIQUE REFERENCES "organization"("id") ON DELETE SET NULL,
  "engine" text NOT NULL UNIQUE,
  "hostname" text NOT NULL UNIQUE,
  "placement" text NOT NULL CHECK ("placement" IN ('standard','dedicated'))
);

--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "managed_mail_account" (
  "organization_id" text PRIMARY KEY REFERENCES "organization"("id") ON DELETE CASCADE,
  "namespace" text NOT NULL UNIQUE,
  "namespace_ready" boolean NOT NULL DEFAULT false,
  "sending_enabled" boolean NOT NULL DEFAULT false,
  "checkout" jsonb
);
