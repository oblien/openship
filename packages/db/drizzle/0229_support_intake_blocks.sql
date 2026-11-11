ALTER TABLE "cloud_support_ticket" ADD COLUMN "client_ip" text;
--> statement-breakpoint
CREATE TABLE "cloud_support_block" (
  "key" text PRIMARY KEY NOT NULL,
  "kind" text NOT NULL,
  "value" text NOT NULL,
  "reason" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "cloud_support_block_kind_check" CHECK ("kind" IN ('email', 'ip'))
);
