CREATE TABLE "action_budget" (
  "organization_id" text PRIMARY KEY REFERENCES "organization"("id") ON DELETE RESTRICT,
  "namespace" text NOT NULL UNIQUE,
  "funded_units" bigint DEFAULT 0 NOT NULL,
  "spent_units" bigint DEFAULT 0 NOT NULL,
  "reserved_units" bigint DEFAULT 0 NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "action_budget_amounts_check" CHECK (
    "funded_units" BETWEEN 0 AND 9007199254740991 AND
    "spent_units" BETWEEN 0 AND 9007199254740991 AND
    "reserved_units" BETWEEN 0 AND 9007199254740991
  )
);
--> statement-breakpoint
CREATE TABLE "action_credit_purchase" (
  "id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "action_budget"("organization_id") ON DELETE RESTRICT,
  "idempotency_key" text NOT NULL,
  "price_cents" integer NOT NULL,
  "request" jsonb NOT NULL,
  "checkout_id" text,
  "checkout_url_enc" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "funded_units" bigint DEFAULT 0 NOT NULL,
  "checked_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "action_purchase_amounts_check" CHECK ("price_cents" > 0 AND "funded_units" BETWEEN 0 AND "price_cents"::bigint * 600000)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "action_purchase_key_unique" ON "action_credit_purchase" ("organization_id", "idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "action_purchase_checkout_unique" ON "action_credit_purchase" ("checkout_id");
--> statement-breakpoint
CREATE INDEX "action_purchase_pending_idx" ON "action_credit_purchase" ("status", "checked_at");
--> statement-breakpoint
CREATE TABLE "action_charge" (
  "job_id" text PRIMARY KEY,
  "organization_id" text NOT NULL REFERENCES "action_budget"("organization_id") ON DELETE RESTRICT,
  "runner_price_id" text NOT NULL,
  "price_version" integer NOT NULL,
  "micro_usd_per_minute" integer NOT NULL,
  "reserved_seconds" integer NOT NULL,
  "reserved_units" bigint NOT NULL,
  "charged_seconds" integer,
  "charged_units" bigint,
  "settled_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  CONSTRAINT "action_charge_amounts_check" CHECK (
    "micro_usd_per_minute" > 0 AND "reserved_seconds" BETWEEN 1 AND 21600 AND
    "reserved_units" = "reserved_seconds"::bigint * "micro_usd_per_minute" AND
    (("settled_at" IS NULL AND "charged_seconds" IS NULL AND "charged_units" IS NULL) OR
     ("settled_at" IS NOT NULL AND "charged_seconds" BETWEEN 0 AND "reserved_seconds" AND "charged_units" = "charged_seconds"::bigint * "micro_usd_per_minute"))
  )
);
--> statement-breakpoint
CREATE INDEX "action_charge_org_idx" ON "action_charge" ("organization_id", "created_at");
