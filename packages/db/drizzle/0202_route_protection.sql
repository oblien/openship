CREATE TABLE "route_protection" (
  "id" text PRIMARY KEY NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "project_id" text NOT NULL REFERENCES "project"("id") ON DELETE CASCADE,
  "hostname" text NOT NULL,
  "secret" text,
  "revision" text NOT NULL,
  "applied_revision" text,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "route_protection_project_host" UNIQUE ("project_id", "hostname")
);
