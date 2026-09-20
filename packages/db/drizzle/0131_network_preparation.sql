CREATE TABLE "managed_network_preparation" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "input_hash" text NOT NULL, "input" jsonb NOT NULL,
  "status" text NOT NULL, "hosts" jsonb NOT NULL,
  "operation_id" text, "error" text, "created_by" text NOT NULL,
  "generation" integer DEFAULT 1 NOT NULL, "lease_expires_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL, "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "managed_network_preparation_org_idx" ON "managed_network_preparation" ("organization_id", "created_at");
