ALTER TABLE "notification_delivery" ADD COLUMN "next_attempt_at" timestamp DEFAULT now() NOT NULL;
--> statement-breakpoint
ALTER TABLE "notification_delivery" ADD COLUMN "lease_until" timestamp;
