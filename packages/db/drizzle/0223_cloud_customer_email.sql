CREATE TABLE "cloud_customer_email" (
  "id" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "payment" jsonb,
  "status" text DEFAULT 'pending' NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now(),
  "lease_id" text,
  "delivered_at" timestamp with time zone,
  "last_error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cloud_customer_email_kind" CHECK ("kind" IN ('signup', 'purchase', 'invoice')),
  CONSTRAINT "cloud_customer_email_status" CHECK ("status" IN ('pending', 'sent', 'canceled', 'failed'))
);
--> statement-breakpoint
CREATE INDEX "cloud_customer_email_due" ON "cloud_customer_email" ("next_attempt_at") WHERE "status" = 'pending';
