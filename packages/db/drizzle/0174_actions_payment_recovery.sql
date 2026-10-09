ALTER TABLE "action_credit_purchase" ADD COLUMN "next_check_at" timestamp DEFAULT now();
--> statement-breakpoint
ALTER TABLE "action_credit_purchase" ADD COLUMN "check_attempts" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "action_credit_purchase" ADD CONSTRAINT "action_purchase_check_attempts_check" CHECK ("check_attempts" BETWEEN 0 AND 10);
--> statement-breakpoint
CREATE INDEX "action_purchase_check_idx" ON "action_credit_purchase" ("next_check_at", "id") WHERE "next_check_at" IS NOT NULL;
