CREATE TABLE "cloud_support_ticket" (
  "id" text PRIMARY KEY NOT NULL,
  "input_hash" text NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "subject" text NOT NULL,
  "message" text NOT NULL,
  "source" text NOT NULL CHECK ("source" IN ('support', 'contact')),
  "status" text DEFAULT 'open' NOT NULL CHECK ("status" IN ('open', 'resolved')),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "cloud_support_ticket_created" ON "cloud_support_ticket" ("created_at", "id");
--> statement-breakpoint
CREATE TABLE "cloud_support_message" (
  "id" text PRIMARY KEY NOT NULL,
  "ticket_id" text NOT NULL REFERENCES "cloud_support_ticket"("id") ON DELETE CASCADE,
  "kind" text NOT NULL CHECK ("kind" IN ('receipt', 'notification', 'reply')),
  "body" text,
  "resolve" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "attempts" integer DEFAULT 0 NOT NULL,
  "next_attempt_at" timestamp with time zone DEFAULT now(),
  "lease_id" text,
  "delivered_at" timestamp with time zone,
  "last_error" text
);
--> statement-breakpoint
CREATE INDEX "cloud_support_message_ticket" ON "cloud_support_message" ("ticket_id", "created_at");
--> statement-breakpoint
CREATE INDEX "cloud_support_message_pending" ON "cloud_support_message" ("next_attempt_at") WHERE "delivered_at" IS NULL;
