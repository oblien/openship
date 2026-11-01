CREATE TABLE "cloud_analytics_event" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text REFERENCES "organization"("id") ON DELETE CASCADE,
  "event" text NOT NULL,
  "distinct_id" text NOT NULL,
  "properties" jsonb NOT NULL,
  "occurred_at" timestamptz DEFAULT now() NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamptz DEFAULT now() NOT NULL,
  "lease_id" text,
  "delivered_at" timestamptz,
  "retain" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cloud_analytics_event_pending" ON "cloud_analytics_event" ("next_attempt_at") WHERE "delivered_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "cloud_analytics_event_retention" ON "cloud_analytics_event" ("delivered_at") WHERE "retain" = false;
--> statement-breakpoint
CREATE TABLE "cloud_analytics_checkout" (
  "id" text PRIMARY KEY NOT NULL,
  "organization_id" text NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "user_id" text NOT NULL,
  "kind" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "next_check_at" timestamptz DEFAULT now(),
  "checks" integer DEFAULT 0 NOT NULL,
  "status" text
);
--> statement-breakpoint
CREATE INDEX "cloud_analytics_checkout_due" ON "cloud_analytics_checkout" ("next_check_at");
--> statement-breakpoint
CREATE TABLE "cloud_analytics_workspace" (
  "organization_id" text PRIMARY KEY NOT NULL REFERENCES "organization"("id") ON DELETE CASCADE,
  "state" jsonb,
  "revision" integer DEFAULT 0 NOT NULL
);
