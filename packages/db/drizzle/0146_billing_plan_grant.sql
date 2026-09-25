CREATE TABLE "billing_plan_grant" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "namespace" text NOT NULL,
  "plan_tier_id" text NOT NULL,
  "offer" jsonb NOT NULL,
  "limits" jsonb NOT NULL,
  "granted_by" text NOT NULL,
  "reason" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "expires_at" timestamptz,
  "revoked_at" timestamptz,
  "revoked_by" text,
  "release_reason" text,
  "released_at" timestamptz,
  "applied_period_end" timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX "billing_plan_grant_current_org" ON "billing_plan_grant" ("organization_id") WHERE "released_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "billing_plan_grant_org_created" ON "billing_plan_grant" ("organization_id", "created_at");
