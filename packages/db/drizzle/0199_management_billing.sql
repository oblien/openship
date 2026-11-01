CREATE TABLE "management_billing" (
  "organization_id" text PRIMARY KEY REFERENCES "organization"("id") ON DELETE RESTRICT,
  "namespace" text NOT NULL UNIQUE,
  "namespace_ready" boolean NOT NULL DEFAULT false,
  "cloud_covered_until" timestamp,
  "checkout" jsonb,
  "change" jsonb,
  "verified" jsonb,
  "checked_at" timestamp,
  "created_at" timestamp NOT NULL DEFAULT now()
);
